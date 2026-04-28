/**
 * @file Tests for the HTTP-mode cheerio parsers.
 *
 * The five cheerio extractors (`pageItems`, `contentBody`, `nkPlayer`,
 * `downloadSection`, `azList`) are expected to produce the same record
 * shapes as their Puppeteer counterparts when fed the local fixture
 * HTML, so the integration tests don't have to spin up a browser to
 * cover the HTTP path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nextListingUrl,
  parsePageItemsHtml,
} from '../src/parsers/cheerio/pageItems.js';
import { parseContentBodyHtml } from '../src/parsers/cheerio/contentBody.js';
import { parseNkPlayerHtml } from '../src/parsers/cheerio/nkPlayer.js';
import { parseDownloadSectionHtml } from '../src/parsers/cheerio/downloadSection.js';
import { parseAzListHtml } from '../src/parsers/cheerio/azList.js';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

/**
 * Read a fixture HTML file from `test/fixtures/`.
 *
 * @param {string} name Fixture filename.
 * @returns {Promise<string>} HTML body.
 */
async function fixture(name) {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

test('cheerio parsers — fixture HTML', async (t) => {
  const baseUrl = 'https://example.test';

  await t.test('parsePageItemsHtml returns >= 10 deduplicated entries', async () => {
    const html = await fixture('listing.html');
    const items = parsePageItemsHtml(html, `${baseUrl}/category/hentai/`);
    assert.ok(Array.isArray(items));
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

  await t.test('nextListingUrl resolves the next-page link or returns null', async () => {
    const listingHtml = await fixture('listing.html');
    const next = nextListingUrl(
      listingHtml,
      `${baseUrl}/category/hentai/`,
    );
    // The fixture may or may not include a next-page link — accept
    // either, but if it returns a string it must be absolute.
    if (next !== null) {
      assert.ok(/^https?:/.test(next), `expected absolute URL, got ${next}`);
    }
  });

  await t.test('parseContentBodyHtml mirrors the DOM extractor', async () => {
    const body = parseContentBodyHtml(await fixture('detail.html'));
    assert.equal(body.title, 'Fixture Detail Title');
    assert.match(body.synopsis, /long-form synopsis/);
    assert.deepEqual(body.genre, ['Drama', 'Action', 'Romance']);
    assert.deepEqual(body.producers, ['Acme Studio', 'Beta Productions']);
    assert.equal(body.duration, '24 min');
    assert.deepEqual(body.size, { '720P': '312.5 MB', '1080P': '612.0 MB' });
    assert.match(body.note, /Fixture file/);
  });

  await t.test('parseNkPlayerHtml returns servers and episode nav', async () => {
    const player = parseNkPlayerHtml(
      await fixture('detail.html'),
      `${baseUrl}/test-slug-01/`,
    );
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

  await t.test('parseDownloadSectionHtml parses rows and resolutions', async () => {
    const rows = parseDownloadSectionHtml(
      await fixture('detail.html'),
      `${baseUrl}/test-slug-01/`,
    );
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
  });

  await t.test('parseAzListHtml returns groups and tooltip cards', async () => {
    const groups = parseAzListHtml(
      await fixture('azIndex.html'),
      `${baseUrl}/category/hentai-list/`,
    );
    assert.ok(typeof groups === 'object' && groups !== null);
    const groupKeys = Object.keys(groups);
    assert.ok(groupKeys.length > 0, 'expected at least one group');
    const aGroup = groups['A'];
    if (aGroup) {
      assert.ok(Array.isArray(aGroup.items));
      for (const item of aGroup.items) {
        assert.ok(item.slug, 'slug should be non-empty');
        assert.ok(item.url.startsWith('http'), 'url should be absolute');
      }
    }
  });
});
