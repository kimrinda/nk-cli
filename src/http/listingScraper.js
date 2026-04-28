/**
 * @file HTTP-mode listing scraper (axios + cheerio).
 *
 * Mirrors the browser-mode pipeline in `src/services/listingScraper.js`
 * but uses an {@link HttpSession} instead of a Puppeteer page. The
 * external behaviour is identical:
 *
 *   * Existing entries on disk are loaded up-front so re-runs only
 *     append new items.
 *   * Atomic save after every successful page (and on shutdown).
 *   * Resume support via the shared {@link ProgressManager}.
 *   * Cookie/session-expired retries are handled by the session layer.
 */

import { config } from '../config/index.js';
import { buildCategoryUrl } from '../config/categories.js';
import {
  nextListingUrl,
  parsePageItemsHtml,
} from '../parsers/cheerio/pageItems.js';
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
 * @typedef {import('./session.js').HttpSession} HttpSession
 */

/**
 * Build the absolute URL of the Nth (1-based) page of a category
 * listing. WordPress uses `/category/<slug>/page/N/` for pages > 1.
 *
 * @param {ResolvedCategory} category Category to navigate.
 * @param {number} pageNumber 1-based page index.
 * @returns {string} Absolute URL.
 */
function listingPageUrl(category, pageNumber) {
  const root = buildCategoryUrl(category).replace(/\/$/, '');
  if (pageNumber <= 1) return `${root}/`;
  return `${root}/page/${pageNumber}/`;
}

/**
 * Run the listing scrape end-to-end via HTTP. Final merged results
 * are written atomically to `category.listingPath`.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ResolvedCategory} category Category to scrape.
 * @param {object} [options] Resume controls supplied by the orchestrator.
 * @param {ProgressManager} [options.progress] Pre-configured progress
 *   manager. When omitted a fresh per-call manager is created.
 * @param {number} [options.startPage] One-based page number to resume
 *   from. Defaults to `1`.
 * @returns {Promise<ListingItem[]>} Final merged list of items.
 */
export async function scrapeListingHttp(session, category, options = {}) {
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

  /** @type {ListingItem[]} */
  const existing = await readJson(category.listingPath, []);
  /** @type {Map<string, ListingItem>} */
  const indexed = new Map(existing.map((item) => [item.slug, item]));
  logger.info('Loaded existing listing entries', {
    category: category.key,
    count: indexed.size,
    file: category.listingPath,
  });

  const saveSync = () =>
    writeJsonSync(category.listingPath, [...indexed.values()]);
  onShutdown(saveSync);

  try {
    let pageNumber = 1;
    let added = 0;
    /** @type {string | null} */
    let nextUrl = listingPageUrl(category, startPage);
    pageNumber = startPage;

    /* eslint-disable no-await-in-loop */
    while (
      pageNumber <= config.scrape.maxListingPages &&
      typeof nextUrl === 'string'
    ) {
      if (abortSignal.aborted || isShutdownInProgress()) {
        logger.warn(
          'Listing loop halted by shutdown signal — preserving progress',
          { category: category.key, lastPage: pageNumber - 1 },
        );
        break;
      }

      /** @type {string} */
      const currentUrl = nextUrl;
      const html = await withRetry(() => session.fetchHtml(currentUrl), {
        attempts: config.scrape.retryAttempts,
        baseDelayMs: config.scrape.retryBaseDelayMs,
        label: `fetchListing(${category.key},${pageNumber})`,
      });
      const items = parsePageItemsHtml(html, currentUrl);

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

      nextUrl = nextListingUrl(html, currentUrl);
      if (!nextUrl) {
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
  }
}
