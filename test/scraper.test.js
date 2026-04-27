/**
 * @file End-to-end integration test for the listing + detail scraper.
 *
 * Spins up a local fixture HTTP server (no live network), points the
 * scraper at it via env vars, and asserts that:
 *
 *   1. `output/hanimeLists.json` contains at least 10 listing entries.
 *   2. `output/hanimeDetails.json` contains at least 10 detail records,
 *      each merging the parsed `content` / `player` / `downloads`
 *      sections from the detail page.
 *
 * Output is redirected into a temp directory via `NK_OUTPUT_DIR` so the
 * project's real `output/` is not touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startFixtureServer } from './helpers/server.js';

/** Minimum number of listing entries the test requires. */
const MIN_LISTING_ITEMS = 10;
/** Minimum number of detail records the test requires. */
const MIN_DETAIL_ITEMS = 10;

test(
  'scraper — fixture run produces >=10 listing items and >=10 detail records',
  { timeout: 180_000 },
  async (t) => {
    const fixture = await startFixtureServer();
    t.after(() => fixture.stop());

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-output-'));
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-userdata-'));
    const logsDir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-logs-'));

    t.after(async () => {
      await Promise.allSettled([
        rm(outputDir, { recursive: true, force: true }),
        rm(userDataDir, { recursive: true, force: true }),
        rm(logsDir, { recursive: true, force: true }),
      ]);
    });

    process.env.NK_BASE_URL = fixture.baseUrl;
    process.env.NK_HOME_URL = `${fixture.baseUrl}/`;
    process.env.NK_OUTPUT_DIR = outputDir;
    process.env.NK_USER_DATA_DIR = userDataDir;
    process.env.NK_LOGS_DIR = logsDir;
    process.env.NK_HEADLESS = 'true';
    process.env.NK_LOG_LEVEL = 'warn';
    process.env.NK_POLITE_DELAY_MS = '0';
    process.env.NK_RETRY_BASE_DELAY_MS = '100';
    process.env.NK_RETRY_ATTEMPTS = '2';
    process.env.NK_NAV_TIMEOUT_MS = '20000';
    process.env.NK_MAX_LIST_PAGES = '1';
    process.env.NK_MAX_DETAIL_ITEMS = '12';

    // Imports happen *after* env vars are set so the frozen `config` picks
    // them up correctly.
    const [
      { launchBrowser, closeBrowser },
      { scrapeListing },
      { scrapeDetails },
      { getCategory },
      { loadAllDetailsForCategory, bucketKeyForTitle },
    ] = await Promise.all([
      import('../src/browser/launcher.js'),
      import('../src/services/listingScraper.js'),
      import('../src/services/detailScraper.js'),
      import('../src/config/categories.js'),
      import('../src/storage/detailStorage.js'),
    ]);

    const category = getCategory('hanime');
    const browser = await launchBrowser();
    let listing;
    let details;
    try {
      listing = await scrapeListing(browser, category);
      details = await scrapeDetails(browser, category, listing);
    } finally {
      await closeBrowser(browser);
    }

    await t.test('listing scrape returns at least 10 items', async () => {
      assert.ok(Array.isArray(listing), 'scrapeListing should return an array');
      assert.ok(
        listing.length >= MIN_LISTING_ITEMS,
        `expected >=${MIN_LISTING_ITEMS} listing items, got ${listing.length}`,
      );
      const slugs = new Set(listing.map((item) => item.slug));
      assert.equal(slugs.size, listing.length, 'listing slugs should be unique');
    });

    await t.test(
      'output/hanimeLists.json on disk contains >=10 entries',
      async () => {
        const raw = await readFile(
          path.join(outputDir, 'hanimeLists.json'),
          'utf8',
        );
        const onDisk = JSON.parse(raw);
        assert.ok(Array.isArray(onDisk));
        assert.ok(
          onDisk.length >= MIN_LISTING_ITEMS,
          `expected >=${MIN_LISTING_ITEMS} entries on disk, got ${onDisk.length}`,
        );
        for (const item of onDisk) {
          assert.ok(item.slug, 'every entry must carry a slug');
          assert.ok(item.title, 'every entry must carry a title');
        }
      },
    );

    await t.test('detail scrape returns at least 10 records', async () => {
      assert.ok(Array.isArray(details), 'scrapeDetails should return an array');
      assert.ok(
        details.length >= MIN_DETAIL_ITEMS,
        `expected >=${MIN_DETAIL_ITEMS} detail records, got ${details.length}`,
      );

      for (const record of details) {
        assert.ok(record.slug, 'record.slug must be set');
        assert.ok(record.url, 'record.url must be set');
        assert.equal(record.content.title, 'Fixture Detail Title');
        assert.deepEqual(record.content.genre, ['Drama', 'Action', 'Romance']);
        assert.equal(record.player.servers.length, 2);
        assert.equal(record.downloads.length, 2);
      }
    });

    await t.test(
      'manifest + per-prefix bucket files on disk contain >=10 records',
      async () => {
        const manifestRaw = await readFile(
          path.join(outputDir, 'details', 'hanime', 'hanimeDetails.manifest.json'),
          'utf8',
        );
        const manifest = JSON.parse(manifestRaw);
        assert.equal(manifest.target, 'hanime');
        assert.equal(manifest.filenamePrefix, 'hanimeDetails');
        assert.ok(
          manifest.totalItems >= MIN_DETAIL_ITEMS,
          `manifest.totalItems should be >= ${MIN_DETAIL_ITEMS}, got ${manifest.totalItems}`,
        );

        // Every group must point at a real bucket file with the
        // matching record count and only records from its bucket.
        let aggregated = 0;
        for (const [bucket, group] of Object.entries(manifest.groups)) {
          const bucketRaw = await readFile(
            path.join(outputDir, 'details', 'hanime', group.file),
            'utf8',
          );
          const bucketRecords = JSON.parse(bucketRaw);
          assert.ok(Array.isArray(bucketRecords));
          assert.equal(bucketRecords.length, group.count);
          for (const record of bucketRecords) {
            assert.equal(
              bucketKeyForTitle(record.listing.title),
              bucket,
              'every record must live in the bucket its title maps to',
            );
          }
          aggregated += bucketRecords.length;
        }
        assert.equal(aggregated, manifest.totalItems);

        // Helper round-trip flatten matches the manifest count.
        const flattened = await loadAllDetailsForCategory(category);
        assert.equal(flattened.length, manifest.totalItems);
      },
    );
  },
);
