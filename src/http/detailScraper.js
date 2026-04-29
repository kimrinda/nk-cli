/**
 * @file HTTP-mode detail scraper (axios + cheerio).
 *
 * Mirrors `src/services/detailScraper.js` but uses an
 * {@link HttpSession} for fetching and the cheerio-based parsers for
 * extraction. The output shape is byte-for-byte identical to the
 * browser-mode scraper, so both methods can write into the same
 * per-prefix bucket store.
 */

import { config } from '../config/index.js';
import { buildDetailUrl } from '../config/categories.js';
import { parseContentBodyHtml } from '../parsers/cheerio/contentBody.js';
import { parseNkPlayerHtml } from '../parsers/cheerio/nkPlayer.js';
import { parseDownloadSectionHtml } from '../parsers/cheerio/downloadSection.js';
import { parseFeaturedImageHtml } from '../parsers/cheerio/featuredImage.js';
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
 * @typedef {import('../services/detailScraper.js').DetailRecord} DetailRecord
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 * @typedef {import('./session.js').HttpSession} HttpSession
 */

/**
 * Scrape a single detail page in isolation.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ResolvedCategory} category Category context for URL building.
 * @param {ListingItem} item Listing entry to expand.
 * @returns {Promise<DetailRecord>} Combined detail record.
 */
async function scrapeOne(session, category, item) {
  const url = buildDetailUrl(category, item);
  const html = await withRetry(() => session.fetchHtml(url), {
    attempts: config.scrape.retryAttempts,
    baseDelayMs: config.scrape.retryBaseDelayMs,
    label: `fetchDetail(${item.slug})`,
  });
  const content = parseContentBodyHtml(html);
  const player = parseNkPlayerHtml(html, url);
  const downloads = parseDownloadSectionHtml(html, url);
  const images = parseFeaturedImageHtml(html);
  return {
    slug: item.slug,
    url,
    category: category.key,
    listing: item,
    content,
    player,
    downloads,
    images,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Scrape every detail page referenced by `items` over HTTP, resuming
 * from any previously-saved progress checkpoint and writing results
 * into the per-prefix detail store.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ResolvedCategory} category Category being processed.
 * @param {ListingItem[]} items Listing entries.
 * @param {object} [options] Resume controls.
 * @param {ProgressManager} [options.progress] Pre-configured manager.
 * @param {number} [options.startIndex] Zero-based start index.
 * @returns {Promise<DetailRecord[]>} Combined detail records.
 */
export async function scrapeDetailsHttp(session, category, items, options = {}) {
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

  const store = createDetailStoreForCategory(category);
  await store.load({
    legacyFile: category.detailPath ?? undefined,
  });
  logger.info('Loaded existing detail records (HTTP mode)', {
    category: category.key,
    count: store.size(),
    buckets: store.bucketKeys().length,
  });

  onShutdown(() => store.flushAllSync());

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
        await progress.update({ lastCompletedIndex: i, totalItems: cap });
        continue;
      }

      try {
        const record = await scrapeOne(session, category, item);
        const { bucket } = await store.upsert(record);
        processed += 1;
        await progress.update({ lastCompletedIndex: i, totalItems: cap });
        logger.info('Detail scraped (HTTP)', {
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
        logger.error('Detail scrape failed (HTTP), continuing', {
          category: category.key,
          slug: item.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await sleep(config.scrape.politeDelayMs);
    }
    /* eslint-enable no-await-in-loop */

    await store.flushManifest();

    if (!isShutdownInProgress()) {
      await progress.markCompleted();
    }

    logger.info('Detail scrape complete (HTTP)', {
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
  }
}

/**
 * Convenience wrapper used by `--scrape <key>info --slug <slug>` to
 * scrape a single detail page on demand without re-running the listing.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ResolvedCategory} category Category context for URL building.
 * @param {string} slug Slug to scrape.
 * @returns {Promise<DetailRecord>} Combined detail record.
 */
export async function scrapeSingleDetailHttp(session, category, slug) {
  const records = await scrapeDetailsHttp(session, category, [
    { slug, title: '', thumbnail: '', url: '' },
  ]);
  const record = records.find((entry) => entry.slug === slug);
  if (!record) {
    throw new Error(`scrapeSingleDetailHttp: no record produced for ${slug}`);
  }
  return record;
}
