/**
 * @file Cheerio-based genre list parser.
 *
 * Extracts genre entries from the `.nk-genre-list` container found on
 * the site homepage. Each `<a>` inside the list becomes a
 * {@link GenreEntry} keyed by its URL slug.
 *
 * The output shape mirrors the reference DOM script provided by the
 * user, adapted for server-side parsing with Cheerio.
 */

import { load } from 'cheerio';

/**
 * A single genre entry.
 *
 * @typedef {object} GenreEntry
 * @property {string} name  Display name scraped from the link text.
 * @property {string} slug  URL-derived slug (last path segment).
 * @property {string} url   Absolute URL of the genre page.
 * @property {string} title Value of the `title` attribute on the link.
 */

/**
 * Collapse non-breaking spaces and repeated whitespace from a value.
 *
 * @param {string} value Raw text content.
 * @returns {string} Cleaned string.
 */
const cleanText = (value) =>
  (value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Derive a slug from the last non-empty segment of a URL path.
 *
 * @param {string} url Absolute or relative URL.
 * @returns {string} Extracted slug, or empty string.
 */
const slugFromUrl = (url) =>
  (url || '').replace(/\/$/, '').split('/').pop() || '';

/**
 * Parse a raw HTML page and extract the genre list.
 *
 * @param {string} html  Raw HTML body (typically the homepage).
 * @param {string} pageUrl Absolute URL the HTML was fetched from; used
 *   to resolve relative `href` values.
 * @returns {Record<string, GenreEntry>} Genre map keyed by slug.
 */
export function parseGenreListHtml(html, pageUrl) {
  const $ = load(html);
  const root = $('.nk-genre-list');

  if (root.length === 0) return {};

  /** @type {Record<string, GenreEntry>} */
  const result = {};

  root.find('a').each((_, el) => {
    const a = $(el);
    const rawHref = a.attr('href') ?? '';
    const href = rawHref ? new URL(rawHref, pageUrl).toString() : '';
    const slug = slugFromUrl(href);
    const name = cleanText(a.text());

    if (!slug || !name) return;

    result[slug] = {
      name,
      slug,
      url: href,
      title: cleanText(a.attr('title') ?? ''),
    };
  });

  return result;
}
