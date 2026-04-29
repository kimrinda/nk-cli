/**
 * @file HTTP-mode genre list scraper (axios + cheerio).
 *
 * Fetches the site homepage via the shared {@link HttpSession} and
 * extracts the `.nk-genre-list` entries using the Cheerio parser.
 * The resulting JSON map is written atomically to the configured
 * output path (`output/genresList.json`).
 */

import path from 'node:path';

import { config } from '../config/index.js';
import { parseGenreListHtml } from '../parsers/cheerio/genreList.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { writeJson } from '../utils/storage.js';

/**
 * @typedef {import('./session.js').HttpSession} HttpSession
 * @typedef {import('../parsers/cheerio/genreList.js').GenreEntry} GenreEntry
 */

/** @type {string} Absolute output path for the genres JSON. */
export const genresOutputPath = path.join(config.paths.output, 'genresList.json');

/**
 * Scrape the genre list from the homepage via HTTP and persist the
 * result to `output/genresList.json`.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @returns {Promise<Record<string, GenreEntry>>} Parsed genre map.
 */
export async function scrapeGenresHttp(session) {
  const url = config.homeUrl;

  logger.info('Fetching homepage for genre list (cli)', { url });

  const html = await withRetry(() => session.fetchHtml(url), {
    attempts: config.scrape.retryAttempts,
    baseDelayMs: config.scrape.retryBaseDelayMs,
    label: 'fetchGenres(cli)',
  });

  const genres = parseGenreListHtml(html, url);
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
}
