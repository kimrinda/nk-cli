/**
 * @file HTTP-mode A–Z index scraper (axios + cheerio).
 *
 * Mirrors `src/services/azScraper.js`. The on-disk payload format is
 * identical to the browser-mode result so callers can switch between
 * methods without invalidating saved data.
 */

import { config } from '../config/index.js';
import { buildCategoryUrl } from '../config/categories.js';
import { parseAzListHtml } from '../parsers/cheerio/azList.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { writeJson, writeJsonSync } from '../utils/storage.js';
import { isShutdownInProgress, onShutdown } from '../utils/shutdown.js';
import { ProgressManager } from '../utils/progressManager.js';

/**
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 * @typedef {import('../services/azScraper.js').AzIndex} AzIndex
 */

/**
 * Scrape the A–Z index for the supplied category over HTTP and write
 * the result to `category.listingPath`.
 *
 * @param {import('./session.js').HttpSession} session Initialised HTTP session.
 * @param {ResolvedCategory} category Category to scrape (must be `azIndex`).
 * @param {object} [options] Resume controls.
 * @param {ProgressManager} [options.progress] Pre-configured manager.
 * @returns {Promise<AzIndex>} Combined index payload.
 */
export async function scrapeAzIndexHttp(session, category, options = {}) {
  if (category.kind !== 'azIndex') {
    throw new Error(
      `scrapeAzIndexHttp: category "${category.key}" is not an azIndex target`,
    );
  }

  const progress =
    options.progress ??
    new ProgressManager({
      command: `scrape:${category.key}:az`,
      outputFile: category.listingPath,
    });
  if (!options.progress) {
    await progress.init({});
  }

  const url = buildCategoryUrl(category);

  /** @type {AzIndex} */
  let payload = {
    category: category.key,
    url,
    scrapedAt: new Date().toISOString(),
    totalGroups: 0,
    totalItems: 0,
    groups: {},
  };

  // Sync flush hook so a SIGINT mid-scrape preserves whatever we have.
  onShutdown(() => writeJsonSync(category.listingPath, payload));

  try {
    const html = await withRetry(() => session.fetchHtml(url), {
      attempts: config.scrape.retryAttempts,
      baseDelayMs: config.scrape.retryBaseDelayMs,
      label: `fetchAz(${category.key})`,
    });
    const groups = parseAzListHtml(html, url);
    const groupKeys = Object.keys(groups);
    const totalItems = groupKeys.reduce(
      (acc, key) => acc + (groups[key]?.items.length ?? 0),
      0,
    );
    payload = {
      category: category.key,
      url,
      scrapedAt: new Date().toISOString(),
      totalGroups: groupKeys.length,
      totalItems,
      groups,
    };

    await writeJson(category.listingPath, payload);
    logger.info('AZ index phase finished (HTTP)', {
      category: category.key,
      groups: payload.totalGroups,
      items: payload.totalItems,
      file: category.listingPath,
    });

    if (!isShutdownInProgress()) {
      await progress.markCompleted();
    }
    return payload;
  } catch (error) {
    await progress.markFailed(error);
    throw error;
  }
}
