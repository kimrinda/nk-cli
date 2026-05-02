/**
 * @file Browser-mode genre list scraper (Puppeteer).
 *
 * Opens the site homepage in a Puppeteer page, waits for the
 * `.nk-genre-list` container to appear (allowing time for any WAF
 * challenge to clear), then evaluates the reference DOM extraction
 * script in the page context.
 *
 * The resulting JSON map is written atomically to the configured
 * output path (`output/genresList.json`).
 */

import path from 'node:path';

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { writeJson } from '../utils/storage.js';

/**
 * @typedef {import('../parsers/cheerio/genreList.js').GenreEntry} GenreEntry
 */

/** @type {string} Absolute output path for the genres JSON. */
export const genresOutputPath = path.join(config.paths.output, 'genresList.json');

/**
 * Page-context function injected via `page.evaluate`. Must be
 * self-contained (no closures over Node variables).
 *
 * @returns {Record<string, {name: string, slug: string, url: string, title: string}>}
 */
function parseGenreListInPage() {
  const root = document.querySelector('.nk-genre-list');

  if (!root) return {};

  /** @param {string} value */
  const cleanText = (value) =>
    (value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** @param {string} url */
  const slugFromUrl = (url) =>
    (url || '').replace(/\/$/, '').split('/').pop();

  return [...root.querySelectorAll('a')].reduce((acc, a) => {
    const slug = slugFromUrl(a.href);
    const name = cleanText(a.textContent);

    if (!slug || !name) return acc;

    acc[slug] = {
      name,
      slug,
      url: a.href,
      title: cleanText(a.getAttribute('title')),
    };

    return acc;
  }, /** @type {Record<string, {name: string, slug: string, url: string, title: string}>} */ ({}));
}

/**
 * Scrape the genre list from the homepage via Puppeteer and persist the
 * result to `output/genresList.json`.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @returns {Promise<Record<string, GenreEntry>>} Parsed genre map.
 */
export async function scrapeGenresBrowser(browser) {
  const page = await newConfiguredPage(browser);

  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/genre-list/`;
    logger.info('Navigating to genre list page (browser)', { url });

    await withRetry(
      async () => {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.navigationTimeoutMs,
        });
        await page.waitForSelector('.nk-genre-list', {
          timeout: config.browser.wafTimeoutMs,
        });
      },
      {
        attempts: config.scrape.retryAttempts,
        baseDelayMs: config.scrape.retryBaseDelayMs,
        label: 'fetchGenres(browser)',
      },
    );

    /** @type {Record<string, GenreEntry>} */
    const genres = await page.evaluate(parseGenreListInPage);
    const count = Object.keys(genres).length;

    if (count === 0) {
      logger.warn('No genres found on homepage — is .nk-genre-list present?', {
        url,
      });
    } else {
      logger.info('Genre list parsed', { count });
    }

    await writeJson(genresOutputPath, genres);
    logger.info('Genre list saved', { file: genresOutputPath, count });

    return genres;
  } finally {
    await page.close().catch(() => undefined);
  }
}
