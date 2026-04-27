/**
 * @file Unit tests for the four DOM parsers.
 *
 * Each parser is a `page.evaluate`-able function that runs in the
 * browser context, so we exercise them by booting a real Puppeteer
 * page, calling `page.setContent` with a fixture HTML snippet, and
 * asserting on the structured object that comes back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, closeBrowser } from '../src/browser/launcher.js';
import { getPageItems } from '../src/parsers/pageItems.js';
import { getContentBody } from '../src/parsers/contentBody.js';
import { parseNkPlayer } from '../src/parsers/nkPlayer.js';
import { getDownloadSection } from '../src/parsers/downloadSection.js';
import { parseAzList } from '../src/parsers/azList.js';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

/**
 * Read a fixture HTML file from `test/fixtures/`.
 *
 * @param {string} name Filename within the fixtures directory.
 * @returns {Promise<string>} HTML body.
 */
async function fixture(name) {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

test('parsers — DOM extractors against fixture HTML', async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  t.after(async () => {
    await page.close().catch(() => undefined);
    await closeBrowser(browser);
  });

  await t.test('getPageItems returns >= 10 deduplicated entries', async () => {
    await page.setContent(await fixture('listing.html'), {
      waitUntil: 'domcontentloaded',
    });
    const items = await page.evaluate(getPageItems);

    assert.ok(Array.isArray(items), 'getPageItems should return an array');
    assert.ok(items.length >= 10, `expected >=10 items, got ${items.length}`);

    for (const item of items) {
      assert.match(item.slug, /^test-slug-\d{2}$/);
      assert.match(item.title, /^Test Title \d{2}$/);
      assert.ok(item.thumbnail, 'thumbnail must be non-empty');
      assert.ok(item.url.endsWith('/'), 'url should keep trailing slash');
    }

    const slugs = new Set(items.map((item) => item.slug));
    assert.equal(slugs.size, items.length, 'slugs should be unique');
  });

  await t.test('getContentBody parses metadata and header', async () => {
    await page.setContent(await fixture('detail.html'), {
      waitUntil: 'domcontentloaded',
    });
    const body = await page.evaluate(getContentBody);

    assert.equal(body.title, 'Fixture Detail Title');
    assert.match(body.synopsis, /long-form synopsis/);
    assert.deepEqual(body.genre, ['Drama', 'Action', 'Romance']);
    assert.deepEqual(body.producers, ['Acme Studio', 'Beta Productions']);
    assert.equal(body.duration, '24 min');
    assert.deepEqual(body.size, { '720P': '312.5 MB', '1080P': '612.0 MB' });
    assert.match(body.note, /Fixture file/);
    assert.match(body.views, /1,234 views/);
    assert.match(body.uploaded, /27 April 2026/);
  });

  await t.test('parseNkPlayer returns servers and episode nav', async () => {
    await page.setContent(await fixture('detail.html'), {
      waitUntil: 'domcontentloaded',
    });
    const player = await page.evaluate(parseNkPlayer);

    assert.equal(player.title, 'Streaming Player');
    assert.equal(player.servers.length, 2);
    assert.deepEqual(
      player.servers.map((server) => server.name),
      ['Mirror 1', 'Mirror 2'],
    );
    assert.equal(player.servers[0].url, 'https://example.test/embed/mirror1');
    assert.equal(player.servers[0].allowFullscreen, true);
    assert.equal(player.servers[1].allowFullscreen, false);
    assert.ok(player.episodeNav.prev);
    assert.ok(player.episodeNav.next);
    assert.equal(player.episodeNav.next.url, 'https://example.test/next/');
  });

  await t.test('getDownloadSection parses rows and resolutions', async () => {
    await page.setContent(await fixture('detail.html'), {
      waitUntil: 'domcontentloaded',
    });
    const rows = await page.evaluate(getDownloadSection);

    assert.equal(rows.length, 2);

    const seven20 = rows.find((row) => row.resolution === '720P');
    const ten80 = rows.find((row) => row.resolution === '1080P');
    assert.ok(seven20, '720P row should be present');
    assert.ok(ten80, '1080P row should be present');

    assert.equal(seven20.links.length, 2);
    assert.deepEqual(
      seven20.links.map((link) => link.host).sort(),
      ['Mega', 'Pixeldrain'],
    );
    assert.equal(ten80.links.length, 1);
    assert.equal(ten80.links[0].host, 'Mega');
  });

  await t.test('parseAzList parses groups, items, and tooltip cards', async () => {
    await page.setContent(await fixture('azIndex.html'), {
      waitUntil: 'domcontentloaded',
    });
    const groups = await page.evaluate(parseAzList);

    assert.deepEqual(Object.keys(groups).sort(), ['A', 'B']);
    assert.equal(groups.A.count, 2);
    assert.equal(groups.B.count, 1);

    const alpha = groups.A.items.find((entry) => entry.slug === 'anime-alpha');
    assert.ok(alpha, 'alpha entry should be found');
    assert.equal(alpha.id, '100');
    assert.equal(alpha.title, 'Alpha Series');
    assert.ok(alpha.tooltip);
    assert.equal(alpha.tooltip.title, 'Alpha Series');
    assert.equal(alpha.tooltip.image, 'https://cdn.example.test/alpha.jpg');
    assert.equal(alpha.tooltip.japaneseName, 'Aruufa Shiriizu');
    assert.deepEqual(alpha.tooltip.producers, ['Studio Alpha', 'Beta Inc']);
    assert.equal(alpha.tooltip.type, 'OVA');
    assert.equal(alpha.tooltip.status, 'Completed');
    assert.deepEqual(alpha.tooltip.genre, ['Drama', 'Action']);
    assert.equal(alpha.tooltip.duration, '24 min');
    assert.equal(alpha.tooltip.score, '8.42');

    // English-labelled fallback (Producer/Duration/Score) on the second item.
    const amber = groups.A.items.find((entry) => entry.slug === 'anime-amber');
    assert.ok(amber);
    assert.deepEqual(amber.tooltip.producers, ['Amber Studio']);
    assert.equal(amber.tooltip.duration, '22 min');
    assert.equal(amber.tooltip.score, '7.5');

    const beta = groups.B.items[0];
    assert.equal(beta.slug, 'anime-beta');
    assert.equal(beta.tooltip.duration, '1 jam 45 menit');
  });
});
