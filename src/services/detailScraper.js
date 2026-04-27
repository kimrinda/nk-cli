/**
 * @file Detail-page scraper.
 *
 * Iterates each listing slug, navigates to the canonical detail URL, and
 * merges the three parsed sections (content body, streaming player,
 * download table) into a single record. Progress is checkpointed after
 * every successful slug to enable resume.
 *
 * The same pipeline runs for every listing-shaped category — output
 * paths (and detail URL conventions) come from the supplied
 * {@link ResolvedCategory}.
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import { buildDetailUrl } from '../config/categories.js';
import { getContentBody } from '../parsers/contentBody.js';
import { parseNkPlayer } from '../parsers/nkPlayer.js';
import { getDownloadSection } from '../parsers/downloadSection.js';
import { logger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';
import {
  getAbortSignal,
  isShutdownInProgress,
  onShutdown,
} from '../utils/shutdown.js';
import { ProgressManager } from '../utils/progressManager.js';
import { createDetailStoreForCategory } from '../storage/detailStorage.js';

/**
 * @typedef {import('../parsers/pageItems.js').ListingItem} ListingItem
 * @typedef {import('../parsers/contentBody.js').ContentBody} ContentBody
 * @typedef {import('../parsers/nkPlayer.js').PlayerData} PlayerData
 * @typedef {import('../parsers/downloadSection.js').DownloadRow} DownloadRow
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 */

/**
 * Combined detail record persisted to disk.
 *
 * @typedef {object} DetailRecord
 * @property {string} slug Unique slug used to derive the URL.
 * @property {string} url Canonical detail URL that was scraped.
 * @property {string} category Category key the record belongs to.
 * @property {ListingItem} listing Listing-page summary (title/thumb).
 * @property {ContentBody} content Parsed `.konten` metadata block.
 * @property {PlayerData} player Parsed `#nk-player` block.
 * @property {DownloadRow[]} downloads Parsed `.nk-download-section` rows.
 * @property {string} scrapedAt ISO 8601 timestamp of capture.
 */

/**
 * Wait until at least one of the detail-page anchors is rendered.
 *
 * The site sometimes hides behind a WAF challenge that has no `.konten`
 * element, so this acts as a positive signal that we have the real DOM.
 *
 * @param {import('puppeteer').Page} page Page navigated to a detail URL.
 * @returns {Promise<void>} Resolves when one of the markers appears.
 */
async function waitForDetailDom(page) {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('.konten') ||
          document.querySelector('#nk-player') ||
          document.querySelector('.nk-download-section'),
      ),
    { timeout: config.browser.wafTimeoutMs, polling: 250 },
  );
}

/**
 * Scrape a single detail page in isolation.
 *
 * @param {import('puppeteer').Page} page Reusable Puppeteer page.
 * @param {ResolvedCategory} category Category context for URL building.
 * @param {ListingItem} item Listing entry to expand.
 * @returns {Promise<DetailRecord>} Combined detail record.
 */
async function scrapeOne(page, category, item) {
  const url = buildDetailUrl(category, item);

  await withRetry(
    async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForDetailDom(page);
    },
    {
      attempts: config.scrape.retryAttempts,
      baseDelayMs: config.scrape.retryBaseDelayMs,
      label: `goto(${item.slug})`,
    },
  );

  const [content, player, downloads] = await Promise.all([
    page.evaluate(getContentBody),
    page.evaluate(parseNkPlayer),
    page.evaluate(getDownloadSection),
  ]);

  return {
    slug: item.slug,
    url,
    category: category.key,
    listing: item,
    content: /** @type {ContentBody} */ (content),
    player: /** @type {PlayerData} */ (player),
    downloads: /** @type {DownloadRow[]} */ (downloads),
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Scrape every detail page referenced by `items`, resuming from any
 * previously-saved progress checkpoint. Final merged results are split
 * into per-prefix bucket files under `category.detailDir`
 * (e.g. `output/details/hanime/hanimeDetails_A.json`,
 * `…/hanimeDetails_0-9.json`, …) and a manifest at
 * `category.detailManifestPath`.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ResolvedCategory} category Category being processed.
 * @param {ListingItem[]} items Listing entries produced by the listing scrape.
 * @param {object} [options] Resume controls supplied by the orchestrator.
 * @param {ProgressManager} [options.progress] Pre-configured progress
 *   manager. When omitted a fresh per-call manager is created.
 * @param {number} [options.startIndex] Zero-based index to start at.
 *   `0` (default) processes every item; previously-scraped slugs are
 *   still skipped via the on-disk dedupe.
 * @returns {Promise<DetailRecord[]>} Combined details for every requested slug.
 */
export async function scrapeDetails(browser, category, items, options = {}) {
  if (!category.detailDir || !category.detailFilenamePrefix) {
    throw new Error(
      `Category "${category.key}" has no detail output configured`,
    );
  }

  const startIndex = Math.max(0, options.startIndex ?? 0);
  const progress =
    options.progress ??
    new ProgressManager({
      command: `scrape:${category.key}:detail`,
      outputFile: /** @type {string} */ (category.detailManifestPath),
      totalItems: items.length,
    });
  if (!options.progress) {
    await progress.init({
      totalItems: items.length,
      lastCompletedIndex: startIndex - 1,
    });
  }
  const abortSignal = getAbortSignal();

  // Materialise (and migrate, if needed) the on-disk per-prefix store.
  const store = createDetailStoreForCategory(category);
  await store.load({
    legacyFile: category.detailPath ?? undefined,
  });
  logger.info('Loaded existing detail records', {
    category: category.key,
    count: store.size(),
    buckets: store.bucketKeys().length,
  });

  // Best-effort flush of every dirty bucket on hard exit. Async upserts
  // already write atomically, so this is just a safety-net for the
  // (rare) case where shutdown fires between an in-memory mutation and
  // its corresponding flush.
  onShutdown(() => store.flushAllSync());

  const page = await newConfiguredPage(browser);

  const cap = config.scrape.maxDetailItems > 0
    ? Math.min(items.length, config.scrape.maxDetailItems)
    : items.length;

  let processed = 0;
  let failed = 0;

  try {
    /* eslint-disable no-await-in-loop */
    for (let i = startIndex; i < cap; i += 1) {
      if (abortSignal.aborted || isShutdownInProgress()) {
        logger.warn(
          'Detail loop halted by shutdown signal — preserving progress',
          { category: category.key, lastIndex: i - 1 },
        );
        break;
      }

      const item = items[i];
      if (store.has(item.slug)) {
        logger.debug('Skipping already-scraped slug', { slug: item.slug });
        await progress.update({
          lastCompletedIndex: i,
          totalItems: cap,
        });
        continue;
      }

      try {
        const record = await scrapeOne(page, category, item);
        const { bucket } = await store.upsert(record);
        processed += 1;
        await progress.update({
          lastCompletedIndex: i,
          totalItems: cap,
        });
        logger.info('Detail scraped', {
          category: category.key,
          slug: item.slug,
          bucket,
          index: i + 1,
          total: cap,
          processed,
          failed,
        });
      } catch (error) {
        failed += 1;
        logger.error('Detail scrape failed, continuing', {
          category: category.key,
          slug: item.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    // Final manifest flush so its `updatedAt` reflects the run's end.
    await store.flushManifest();

    if (!isShutdownInProgress()) {
      await progress.markCompleted();
    }

    logger.info('Detail scrape complete', {
      category: category.key,
      total: store.size(),
      buckets: store.bucketKeys().length,
      processed,
      failed,
    });
    return store.flattenAll();
  } catch (error) {
    await progress.markFailed(error);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Convenience wrapper used by `scrape:info --slug <slug>` to scrape a
 * single detail page on demand without re-running the listing.
 *
 * Existing records on disk are still consulted so re-running with the
 * same slug returns the cached value (no duplicate writes).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ResolvedCategory} category Category context for URL building.
 * @param {string} slug Slug to scrape.
 * @returns {Promise<DetailRecord>} Combined detail record.
 */
export async function scrapeSingleDetail(browser, category, slug) {
  const records = await scrapeDetails(browser, category, [{
    slug,
    title: '',
    thumbnail: '',
    url: '',
  }]);
  const record = records.find((entry) => entry.slug === slug);
  if (!record) {
    throw new Error(`scrapeSingleDetail: no record produced for ${slug}`);
  }
  return record;
}
