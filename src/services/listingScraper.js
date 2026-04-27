/**
 * @file Listing scraper that walks `/category/hentai` page-by-page.
 *
 * Implements:
 *   * Homepage entry → click the "Hentai" menu link
 *   * Continuous pagination via `.next.page-numbers`
 *   * Resume support: existing `hanimeLists.json` slugs are loaded up-front
 *     and used to deduplicate so re-runs only append new items
 *   * Atomic save after every successful page (and on shutdown)
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import {
  clickHentaiMenu,
  clickNextPage,
  getPageItems,
  hasNextPage,
} from '../parsers/pageItems.js';
import { logger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';
import { readJson, writeJson, writeJsonSync } from '../utils/storage.js';
import { onShutdown } from '../utils/shutdown.js';

/**
 * @typedef {import('../parsers/pageItems.js').ListingItem} ListingItem
 */

/**
 * Wait for the `.nk-search-results` container — the hard signal that the
 * listing DOM is rendered and not stuck on a WAF challenge page.
 *
 * @param {import('puppeteer').Page} page Page navigated to a listing URL.
 * @returns {Promise<void>} Resolves when the selector appears.
 */
async function waitForListingDom(page) {
  await page.waitForSelector('.nk-search-results li', {
    timeout: config.browser.navigationTimeoutMs,
  });
}

/**
 * Navigate from the homepage to the Hentai category landing page.
 *
 * @param {import('puppeteer').Page} page Configured Puppeteer page.
 * @returns {Promise<void>} Resolves once the listing DOM is rendered.
 */
async function enterHentaiCategory(page) {
  logger.info('Opening homepage', { url: config.homeUrl });
  await page.goto(config.homeUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('li > a')].some(
        (anchor) => anchor.textContent?.toLowerCase().trim() === 'hentai',
      ),
    { timeout: config.browser.navigationTimeoutMs },
  );

  logger.info('Clicking Hentai menu');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.evaluate(clickHentaiMenu),
  ]);

  await waitForListingDom(page);
}

/**
 * Advance to the next listing page via the `.next.page-numbers` link.
 *
 * @param {import('puppeteer').Page} page Page positioned on a listing page.
 * @returns {Promise<boolean>} True when navigation occurred, false if no next link.
 */
async function advanceListingPage(page) {
  const more = await page.evaluate(hasNextPage);
  if (!more) return false;

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.evaluate(clickNextPage),
  ]);

  await waitForListingDom(page);
  return true;
}

/**
 * Run the listing scrape end-to-end. Existing entries on disk are merged
 * with the freshly-scraped pages (deduplicated by slug).
 *
 * @param {import('puppeteer').Browser} browser Browser launched by the caller.
 * @returns {Promise<ListingItem[]>} Final merged list of items.
 */
export async function scrapeListing(browser) {
  const page = await newConfiguredPage(browser);

  /** @type {ListingItem[]} */
  const existing = await readJson(config.paths.listingFile, []);
  /** @type {Map<string, ListingItem>} */
  const indexed = new Map(existing.map((item) => [item.slug, item]));
  logger.info('Loaded existing listing entries', { count: indexed.size });

  /**
   * Persist the in-memory set of items to disk synchronously. Used for
   * shutdown hooks where async saves would race the process exit.
   *
   * @returns {void}
   */
  const saveSync = () =>
    writeJsonSync(config.paths.listingFile, [...indexed.values()]);

  onShutdown(saveSync);

  try {
    await withRetry(() => enterHentaiCategory(page), {
      attempts: config.scrape.retryAttempts,
      baseDelayMs: config.scrape.retryBaseDelayMs,
      label: 'enterHentaiCategory',
    });

    let pageNumber = 1;
    let added = 0;

    /* eslint-disable no-await-in-loop */
    while (pageNumber <= config.scrape.maxListingPages) {
      const items = await withRetry(
        async () => {
          await waitForListingDom(page);
          return /** @type {ListingItem[]} */ (
            await page.evaluate(getPageItems)
          );
        },
        {
          attempts: config.scrape.retryAttempts,
          baseDelayMs: config.scrape.retryBaseDelayMs,
          label: `listingPage(${pageNumber})`,
        },
      );

      let pageAdds = 0;
      for (const item of items) {
        if (!indexed.has(item.slug)) {
          indexed.set(item.slug, item);
          pageAdds += 1;
          added += 1;
        }
      }

      logger.info('Listing page scraped', {
        page: pageNumber,
        items: items.length,
        newItems: pageAdds,
        total: indexed.size,
      });

      await writeJson(config.paths.listingFile, [...indexed.values()]);

      const advanced = await withRetry(() => advanceListingPage(page), {
        attempts: config.scrape.retryAttempts,
        baseDelayMs: config.scrape.retryBaseDelayMs,
        label: `advanceListingPage(${pageNumber})`,
      }).catch((error) => {
        logger.error('Failed to advance listing page', {
          page: pageNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });

      if (!advanced) {
        logger.info('No more listing pages', { lastPage: pageNumber });
        break;
      }

      pageNumber += 1;
      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    logger.info('Listing scrape complete', {
      pages: pageNumber,
      total: indexed.size,
      newlyAdded: added,
    });

    saveSync();
    return [...indexed.values()];
  } finally {
    await page.close().catch(() => undefined);
  }
}
