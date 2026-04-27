/**
 * @file Detail-page scraper.
 *
 * Iterates each listing slug, navigates to the canonical detail URL, and
 * merges the three parsed sections (content body, streaming player,
 * download table) into a single record. Progress is checkpointed after
 * every successful slug to enable resume.
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
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
 */

/**
 * Combined detail record persisted to disk.
 *
 * @typedef {object} DetailRecord
 * @property {string} slug Unique slug used to derive the URL.
 * @property {string} url Canonical detail URL that was scraped.
 * @property {ListingItem} listing Listing-page summary (title/thumb).
 * @property {ContentBody} content Parsed `.konten` metadata block.
 * @property {PlayerData} player Parsed `#nk-player` block.
 * @property {DownloadRow[]} downloads Parsed `.nk-download-section` rows.
 * @property {string} scrapedAt ISO 8601 timestamp of capture.
 */

/**
 * Build the canonical detail URL for a listing entry.
 *
 * @param {ListingItem} item Listing entry.
 * @returns {string} Absolute URL of the detail page.
 */
function buildDetailUrl(item) {
  if (item.url) return item.url;
  return `${config.baseUrl.replace(/\/$/, '')}/${item.slug}/`;
}

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
    { timeout: config.browser.navigationTimeoutMs },
  );
}

/**
 * Scrape a single detail page in isolation.
 *
 * @param {import('puppeteer').Page} page Reusable Puppeteer page.
 * @param {ListingItem} item Listing entry to expand.
 * @returns {Promise<DetailRecord>} Combined detail record.
 */
async function scrapeOne(page, item) {
  const url = buildDetailUrl(item);

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
 * `output/hanimeDetails.json`.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ListingItem[]} items Listing entries produced by the listing scrape.
 * @returns {Promise<DetailRecord[]>} Combined details for every requested slug.
 */
export async function scrapeDetails(browser, items) {
  const page = await newConfiguredPage(browser);

  /** @type {DetailRecord[]} */
  const finalRecords = await readJson(config.paths.detailFile, []);
  /** @type {DetailRecord[]} */
  const progressRecords = await readJson(config.paths.detailProgressFile, []);

  /** @type {Map<string, DetailRecord>} */
  const indexed = new Map();
  for (const record of [...finalRecords, ...progressRecords]) {
    indexed.set(record.slug, record);
  }
  logger.info('Loaded existing detail records', { count: indexed.size });

  /**
   * Persist the in-memory map synchronously. Used by the shutdown hook.
   *
   * @returns {void}
   */
  const saveSync = () => {
    const snapshot = [...indexed.values()];
    writeJsonSync(config.paths.detailProgressFile, snapshot);
    writeJsonSync(config.paths.detailFile, snapshot);
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
        const record = await scrapeOne(page, item);
        indexed.set(record.slug, record);
        processed += 1;
        await writeJson(
          config.paths.detailProgressFile,
          [...indexed.values()],
        );
        logger.info('Detail scraped', {
          slug: item.slug,
          index: i + 1,
          total: cap,
          processed,
          failed,
        });
      } catch (error) {
        failed += 1;
        logger.error('Detail scrape failed, continuing', {
          slug: item.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    const merged = [...indexed.values()];
    await writeJson(config.paths.detailFile, merged);
    await writeJson(config.paths.detailProgressFile, merged);

    logger.info('Detail scrape complete', {
      total: merged.length,
      processed,
      failed,
    });
    return merged;
  } finally {
    await page.close().catch(() => undefined);
  }
}
