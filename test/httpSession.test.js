/**
 * @file Tests for the HTTP-mode helpers.
 *
 * Verifies cookie-store IO (Cookie-Editor JSON shape, header
 * serialisation, paste parsing) and the {@link HttpSession} happy-path
 * + WAF-retry behaviour against a small in-process HTTP server.
 *
 * The cookie-refresh prompt is suppressed via `NK_AUTO_COOKIE_REFRESH=no`
 * so the WAF-rejection path can be observed without blocking on stdin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cookiesToHeader,
  parsePastedCookies,
  readCookies,
  writeCookies,
} from '../src/http/cookieStore.js';
import { isSessionExpiredBody, isSessionExpiredStatus } from '../src/http/client.js';
import { HttpSession } from '../src/http/session.js';

/**
 * Allocate a fresh tempdir scoped to a test.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @returns {Promise<string>} Absolute directory path.
 */
async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Spin up a tiny HTTP server backed by a per-test response queue.
 * Each entry is `{ status, body }` and is consumed in order.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @param {{status:number, body:string}[]} responses Queued responses.
 * @returns {Promise<{ url: string, hits: string[] }>} Base URL and the
 *   list of received cookie headers (one entry per request).
 */
async function startQueueServer(t, responses) {
  const queue = [...responses];
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers.cookie ?? '');
    const next = queue.shift() ?? { status: 500, body: 'queue exhausted' };
    res.writeHead(next.status, { 'Content-Type': 'text/html' });
    res.end(next.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server.address() returned unexpected value');
  }
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      }),
  );
  return { url: `http://127.0.0.1:${address.port}`, hits };
}

test('cookieStore — read/write roundtrips Cookie-Editor JSON', async (t) => {
  const dir = await tempDir(t);
  const filePath = path.join(dir, 'nk-cookies.json');
  await writeCookies(
    [
      { name: 'a', value: '1', domain: 'example.test' },
      { name: 'b', value: '2' },
    ],
    filePath,
  );
  const cookies = await readCookies(filePath);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, 'a');
  assert.equal(cookies[1].value, '2');
});

test('cookieStore — header serialisation skips empty names', () => {
  const header = cookiesToHeader([
    { name: 'a', value: '1' },
    { name: '', value: 'oops' },
    { name: 'b', value: '' },
  ]);
  assert.equal(header, 'a=1; b=');
});

test('cookieStore — parsePastedCookies accepts JSON arrays', () => {
  const parsed = parsePastedCookies(
    JSON.stringify([
      { name: 'session', value: 'abc' },
      { name: 'tracker', value: 'xyz' },
    ]),
  );
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed?.[0]?.name, 'session');
});

test('cookieStore — parsePastedCookies accepts header-style strings', () => {
  const parsed = parsePastedCookies('Cookie: foo=bar; baz=qux');
  assert.ok(parsed);
  assert.deepEqual(parsed, [
    { name: 'foo', value: 'bar' },
    { name: 'baz', value: 'qux' },
  ]);
});

test('client — isSessionExpiredStatus + body markers', () => {
  assert.equal(isSessionExpiredStatus(468), true);
  assert.equal(isSessionExpiredStatus(403), true);
  assert.equal(isSessionExpiredStatus(200), false);
  assert.equal(isSessionExpiredBody('<html>just a moment...</html>'), true);
  assert.equal(isSessionExpiredBody('<html><body>hello</body></html>'), false);
});

test('HttpSession — happy path returns body and sends cookies', async (t) => {
  const dir = await tempDir(t);
  const cookieFilePath = path.join(dir, 'nk-cookies.json');
  await writeFile(
    cookieFilePath,
    JSON.stringify([{ name: 'sid', value: 'v1' }]),
    'utf8',
  );

  const server = await startQueueServer(t, [
    { status: 200, body: '<html><body>ok</body></html>' },
  ]);

  const session = new HttpSession({ cookieFilePath });
  await session.init();
  const body = await session.fetchHtml(`${server.url}/`);
  assert.match(body, /ok/);
  assert.equal(server.hits.length, 1);
  assert.equal(server.hits[0], 'sid=v1');
});

test('HttpSession — surfaces a clear error when the WAF blocks and prompt is disabled', async (t) => {
  const dir = await tempDir(t);
  const cookieFilePath = path.join(dir, 'nk-cookies.json');
  await writeFile(
    cookieFilePath,
    JSON.stringify([{ name: 'sid', value: 'expired' }]),
    'utf8',
  );

  const previous = process.env.NK_AUTO_COOKIE_REFRESH;
  process.env.NK_AUTO_COOKIE_REFRESH = 'no';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.NK_AUTO_COOKIE_REFRESH;
    } else {
      process.env.NK_AUTO_COOKIE_REFRESH = previous;
    }
  });

  const server = await startQueueServer(t, [
    { status: 468, body: 'WAF blocked' },
  ]);

  const session = new HttpSession({ cookieFilePath });
  await session.init();
  await assert.rejects(
    () => session.fetchHtml(`${server.url}/blocked`),
    /WAF/i,
  );
  // When the prompt is disabled the request is not retried, so we
  // should have observed exactly one upstream hit.
  assert.equal(server.hits.length, 1);
});

test('HttpSession — applyCookies rebuilds the client', async (t) => {
  const dir = await tempDir(t);
  const cookieFilePath = path.join(dir, 'nk-cookies.json');
  await writeFile(cookieFilePath, JSON.stringify([]), 'utf8');

  const server = await startQueueServer(t, [
    { status: 200, body: 'ok' },
    { status: 200, body: 'ok' },
  ]);

  const session = new HttpSession({ cookieFilePath });
  await session.init();
  await session.fetchHtml(`${server.url}/first`);
  session.applyCookies([{ name: 'fresh', value: 'value' }]);
  await session.fetchHtml(`${server.url}/second`);

  assert.equal(server.hits[0], '');
  assert.equal(server.hits[1], 'fresh=value');

  // Sanity: file-on-disk untouched (applyCookies is in-memory only).
  const onDisk = JSON.parse(await readFile(cookieFilePath, 'utf8'));
  assert.deepEqual(onDisk, []);
});
