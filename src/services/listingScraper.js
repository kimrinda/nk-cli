/**
 * @file Generic listing scraper that walks any `/category/<slug>` page.
 *
 * Implements:
 *   * Homepage entry → click the matching menu link by text
 *   * Continuous pagination via `.next.page-numbers`
 *   * Resume support: existing listing JSON entries are loaded up-front
 *     and used to deduplicate so re-runs only append new items
 *   * Atomic save after every successful page (and on shutdown)
 *
 * The same pipeline is reused for `hanime`, `2d-animation`,
 * `3d-hentai`, `jav-cosplay` and `jav` — only the menu text and the
 * output filename differ (see `src/config/categories.js`).
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import {
  clickMenuByText,
  clickNextPage,
  getPageItems,
  hasMenuByText,
  hasNextPage,
} from '../parsers/pageItems.js';
import { logger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';
import { readJson, writeJson, writeJsonSync } from '../utils/storage.js';
import {
  getAbortSignal,
  isShutdownInProgress,
  onShutdown,
} from '../utils/shutdown.js';
import { ProgressManager } from '../utils/progressManager.js';

/**
 * @typedef {import('../parsers/pageItems.js').ListingItem} ListingItem
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 */

/**
 * Wait for the `.nk-search-results` container — the hard signal that the
 * listing DOM is rendered and not stuck on a WAF challenge page.
 *
 * Uses the WAF-grade timeout (rather than the regular navigation
 * timeout) so a slow first-load challenge does not poison the wait.
 *
 * @param {import('puppeteer').Page} page Page navigated to a listing URL.
 * @returns {Promise<void>} Resolves when the selector appears.
 */
async function waitForListingDom(page) {
  await page.waitForSelector('.nk-search-results li', {
    timeout: config.browser.wafTimeoutMs,
  });
}

/**
 * Navigate from the homepage to the requested category landing page.
 *
 * Sequence (event-driven — never sleeps for the full WAF timeout when
 * the page is already in the DOM):
 *   1. `goto(home, { waitUntil: 'domcontentloaded' })` — returns the
 *      moment the homepage HTML is parsed. `networkidle2` is avoided
 *      here because ad/tracker traffic on the live homepage keeps the
 *      network busy indefinitely and would otherwise consume the full
 *      `wafTimeoutMs` budget before we even start polling for the menu.
 *   2. `waitForFunction(hasMenuByText, polling: 250)` until the menu
 *      link renders. The WAF-grade timeout is kept as the outer ceiling
 *      so a slow WAF challenge still has room to clear, but the moment
 *      the element appears we proceed.
 *   3. Click + waitForNavigation onto `/category/<slug>/` (using the
 *      regular navigation timeout) and assert the listing DOM.
 *
 * @param {import('puppeteer').Page} page Configured Puppeteer page.
 * @param {ResolvedCategory} category Target category whose menu link to click.
 * @returns {Promise<void>} Resolves once the listing DOM is rendered.
 */
async function enterCategory(page, category) {
  logger.info('Opening homepage', { url: config.homeUrl, category: category.key });
  await page.goto(config.homeUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.browser.navigationTimeoutMs,
  });

  logger.debug('Waiting for menu link', {
    menuText: category.menuText,
    timeoutMs: config.browser.wafTimeoutMs,
  });
  await page.waitForFunction(hasMenuByText, {
    timeout: config.browser.wafTimeoutMs,
    polling: 250,
  }, category.menuText);

  logger.info('Clicking menu link', {
    menuText: category.menuText,
    label: category.label,
  });
  await Promise.all([
    page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs,
    }),
    page.evaluate(clickMenuByText, category.menuText),
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
 * @param {ResolvedCategory} category Category to scrape.
 * @param {object} [options] Resume controls supplied by the orchestrator.
 * @param {ProgressManager} [options.progress] Pre-configured progress
 *   manager. When omitted a fresh per-call manager is created.
 * @param {number} [options.startPage] One-based page number to resume
 *   from. Defaults to `1` (run from the first page).
 * @returns {Promise<ListingItem[]>} Final merged list of items.
 */
export async function scrapeListing(browser, category, options = {}) {
  const startPage = Math.max(1, options.startPage ?? 1);
  const progress =
    options.progress ??
    new ProgressManager({
      command: `scrape:${category.key}:listing`,
      outputFile: category.listingPath,
    });
  if (!options.progress) {
    await progress.init({ lastCompletedIndex: startPage - 2 });
  }
  const abortSignal = getAbortSignal();

  const page = await newConfiguredPage(browser);

  /** @type {ListingItem[]} */
  const existing = await readJson(category.listingPath, []);
  /** @type {Map<string, ListingItem>} */
  const indexed = new Map(existing.map((item) => [item.slug, item]));
  logger.info('Loaded existing listing entries', {
    category: category.key,
    count: indexed.size,
    file: category.listingPath,
  });

  /**
   * Persist the in-memory set of items to disk synchronously. Used for
   * shutdown hooks where async saves would race the process exit.
   *
   * @returns {void}
   */
  const saveSync = () =>
    writeJsonSync(category.listingPath, [...indexed.values()]);

  onShutdown(saveSync);

  try {
    await withRetry(() => enterCategory(page, category), {
      attempts: config.scrape.retryAttempts,
      baseDelayMs: config.scrape.retryBaseDelayMs,
      label: `enterCategory(${category.key})`,
    });

    let pageNumber = 1;
    let added = 0;

    /* eslint-disable no-await-in-loop */
    while (pageNumber <= config.scrape.maxListingPages) {
      if (abortSignal.aborted || isShutdownInProgress()) {
        logger.warn(
          'Listing loop halted by shutdown signal — preserving progress',
          { category: category.key, lastPage: pageNumber - 1 },
        );
        break;
      }

      if (pageNumber < startPage) {
        const advanced = await advanceListingPage(page).catch(() => false);
        if (!advanced) break;
        pageNumber += 1;
        continue;
      }
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
          label: `listingPage(${category.key},${pageNumber})`,
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
        category: category.key,
        page: pageNumber,
        items: items.length,
        newItems: pageAdds,
        total: indexed.size,
      });

      await writeJson(category.listingPath, [...indexed.values()]);
      await progress.update({
        lastCompletedIndex: pageNumber - 1,
        totalItems: indexed.size,
      });

      const advanced = await withRetry(() => advanceListingPage(page), {
        attempts: config.scrape.retryAttempts,
        baseDelayMs: config.scrape.retryBaseDelayMs,
        label: `advanceListingPage(${category.key},${pageNumber})`,
      }).catch((error) => {
        logger.error('Failed to advance listing page', {
          category: category.key,
          page: pageNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });

      if (!advanced) {
        logger.info('No more listing pages', {
          category: category.key,
          lastPage: pageNumber,
        });
        break;
      }

      pageNumber += 1;
      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    logger.info('Listing scrape complete', {
      category: category.key,
      pages: pageNumber,
      total: indexed.size,
      newlyAdded: added,
    });

    saveSync();
    if (!isShutdownInProgress()) {
      await progress.markCompleted();
    }
    return [...indexed.values()];
  } catch (error) {
    await progress.markFailed(error);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}
