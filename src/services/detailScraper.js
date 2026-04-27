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
import { readJson, writeJson, writeJsonSync } from '../utils/storage.js';
import { onShutdown } from '../utils/shutdown.js';

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
 * previously-saved progress checkpoint. Final merged results land in
 * the category's `detailPath` (e.g. `output/hanimeDetails.json`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ResolvedCategory} category Category being processed.
 * @param {ListingItem[]} items Listing entries produced by the listing scrape.
 * @returns {Promise<DetailRecord[]>} Combined details for every requested slug.
 */
export async function scrapeDetails(browser, category, items) {
  if (!category.detailPath || !category.detailProgressPath) {
    throw new Error(
      `Category "${category.key}" has no detail output configured`,
    );
  }
  const detailPath = category.detailPath;
  const progressPath = category.detailProgressPath;

  const page = await newConfiguredPage(browser);

  /** @type {DetailRecord[]} */
  const finalRecords = await readJson(detailPath, []);
  /** @type {DetailRecord[]} */
  const progressRecords = await readJson(progressPath, []);

  /** @type {Map<string, DetailRecord>} */
  const indexed = new Map();
  for (const record of [...finalRecords, ...progressRecords]) {
    indexed.set(record.slug, record);
  }
  logger.info('Loaded existing detail records', {
    category: category.key,
    count: indexed.size,
  });

  /**
   * Persist the in-memory map synchronously. Used by the shutdown hook.
   *
   * @returns {void}
   */
  const saveSync = () => {
    const snapshot = [...indexed.values()];
    writeJsonSync(progressPath, snapshot);
    writeJsonSync(detailPath, snapshot);
  };
  onShutdown(saveSync);

  const cap = config.scrape.maxDetailItems > 0
    ? Math.min(items.length, config.scrape.maxDetailItems)
    : items.length;

  let processed = 0;
  let failed = 0;

  try {
    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < cap; i += 1) {
      const item = items[i];
      if (indexed.has(item.slug)) {
        logger.debug('Skipping already-scraped slug', { slug: item.slug });
        continue;
      }

      try {
        const record = await scrapeOne(page, category, item);
        indexed.set(record.slug, record);
        processed += 1;
        await writeJson(progressPath, [...indexed.values()]);
        logger.info('Detail scraped', {
          category: category.key,
          slug: item.slug,
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

    const merged = [...indexed.values()];
    await writeJson(detailPath, merged);
    await writeJson(progressPath, merged);

    logger.info('Detail scrape complete', {
      category: category.key,
      total: merged.length,
      processed,
      failed,
    });
    return merged;
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
