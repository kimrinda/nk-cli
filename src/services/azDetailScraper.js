/**
 * @file Browser-mode series detail scraper for hanimeindex items.
 *
 * Reads the A–Z index from `output/hanimeIndex.json`, iterates every
 * item, navigates Puppeteer to the series page at
 * `<host>/hentai/<slug>/`, evaluates the DOM-based
 * {@link parseSeriesPage} extractor in the page context, and writes
 * the result back into the index JSON under
 * `groups.X.items[N].details`.
 *
 * Supports resume via a flat-index progress tracker and honours the
 * shutdown signal for graceful SIGINT handling.
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import { parseSeriesPage } from '../parsers/seriesPage.js';
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
 * @typedef {import('../parsers/seriesPage.js').SeriesPageData} SeriesPageData
 * @typedef {import('./azScraper.js').AzIndex} AzIndex
 */

/**
 * Flat reference to a single item inside the nested A–Z groups,
 * used to iterate items with a linear index for resume tracking.
 *
 * @typedef {object} FlatAzRef
 * @property {string} groupKey Letter group key (e.g. `A`).
 * @property {number} itemIndex Position within the group's items array.
 * @property {string} slug URL slug.
 * @property {string} url Absolute detail URL.
 */

/**
 * Flatten the nested AzIndex groups into a linear list of references.
 *
 * @param {AzIndex} index Loaded A–Z index payload.
 * @returns {FlatAzRef[]} Ordered list of item references.
 */
function flattenAzItems(index) {
  /** @type {FlatAzRef[]} */
  const refs = [];
  for (const [groupKey, group] of Object.entries(index.groups)) {
    for (let i = 0; i < group.items.length; i += 1) {
      const item = group.items[i];
      refs.push({
        groupKey,
        itemIndex: i,
        slug: item.slug,
        url: item.url || `${config.baseUrl.replace(/\/$/, '')}/hentai/${item.slug}/`,
      });
    }
  }
  return refs;
}

/**
 * Wait for at least one of the series-page markers to appear.
 *
 * @param {import('puppeteer').Page} page Page navigated to a series URL.
 * @returns {Promise<void>} Resolves when the DOM is ready.
 */
async function waitForSeriesDom(page) {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('.nk-series-meta-list') ||
          document.querySelector('.nk-episode-grid'),
      ),
    { timeout: config.browser.wafTimeoutMs, polling: 250 },
  );
}

/**
 * Scrape series details for every item in the hanimeindex via Puppeteer.
 *
 * Results are written in-place into the AzIndex JSON under
 * `groups.X.items[N].details` and flushed atomically after each
 * successful scrape.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {string} indexPath Absolute path to `hanimeIndex.json`.
 * @param {object} [options] Resume controls.
 * @param {ProgressManager} [options.progress] Pre-configured manager.
 * @param {number} [options.startIndex] Zero-based start index.
 * @returns {Promise<number>} Total number of items successfully scraped.
 */
export async function scrapeAzDetailsBrowser(browser, indexPath, options = {}) {
  /** @type {AzIndex} */
  const index = await readJson(indexPath, /** @type {any} */ (null));
  if (!index || !index.groups) {
    throw new Error(
      `Cannot load hanimeIndex from ${indexPath} — run --scrape hanimeindex first.`,
    );
  }

  const refs = flattenAzItems(index);
  if (refs.length === 0) {
    logger.warn('No items found in hanimeIndex — nothing to scrape', {
      file: indexPath,
    });
    return 0;
  }

  const startIndex = Math.max(0, options.startIndex ?? 0);
  const progress =
    options.progress ??
    new ProgressManager({
      command: 'scrape:hanimeindex:detail',
      outputFile: indexPath,
    });
  if (!options.progress) {
    await progress.init({
      totalItems: refs.length,
      lastCompletedIndex: startIndex - 1,
    });
  }
  const abortSignal = getAbortSignal();

  const saveSync = () => writeJsonSync(indexPath, index);
  onShutdown(saveSync);

  const page = await newConfiguredPage(browser);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    /* eslint-disable no-await-in-loop */
    for (let i = startIndex; i < refs.length; i += 1) {
      if (abortSignal.aborted || isShutdownInProgress()) {
        logger.warn(
          'AZ detail loop halted by shutdown — preserving progress',
          { lastIndex: i - 1 },
        );
        break;
      }

      const ref = refs[i];
      const item = index.groups[ref.groupKey].items[ref.itemIndex];

      // Skip already-scraped items.
      if (item.details && Object.keys(item.details).length > 0) {
        skipped += 1;
        await progress.update({ lastCompletedIndex: i, totalItems: refs.length });
        logger.debug('Skipping already-scraped slug', { slug: ref.slug });
        continue;
      }

      try {
        await withRetry(
          async () => {
            await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
            await waitForSeriesDom(page);
          },
          {
            attempts: config.scrape.retryAttempts,
            baseDelayMs: config.scrape.retryBaseDelayMs,
            label: `gotoSeriesPage(${ref.slug})`,
          },
        );

        /** @type {SeriesPageData} */
        const details = await page.evaluate(parseSeriesPage);
        item.details = details;
        processed += 1;

        await writeJson(indexPath, index);
        await progress.update({ lastCompletedIndex: i, totalItems: refs.length });

        logger.info('Series detail scraped (browser)', {
          slug: ref.slug,
          group: ref.groupKey,
          index: i + 1,
          total: refs.length,
          processed,
          skipped,
          failed,
        });
      } catch (error) {
        failed += 1;
        logger.error('Series detail scrape failed (browser), continuing', {
          slug: ref.slug,
          url: ref.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    saveSync();

    if (!isShutdownInProgress()) {
      await progress.markCompleted();
    }

    logger.info('AZ detail scrape complete (browser)', {
      total: refs.length,
      processed,
      skipped,
      failed,
    });

    return processed;
  } catch (error) {
    await progress.markFailed(error);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}
