/**
 * @file Cheerio (HTTP-mode) parser for hanimeindex series pages.
 *
 * Mirrors the browser-side `src/parsers/seriesPage.js` extractor but
 * operates on a static HTML tree loaded with cheerio instead of a live
 * Puppeteer page.
 *
 * The output shape is identical to the browser-mode parser so downstream
 * callers can treat both modes uniformly.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../seriesPage.js').SeriesPageData} SeriesPageData
 * @typedef {import('../seriesPage.js').SeriesGenre} SeriesGenre
 * @typedef {import('../seriesPage.js').SeriesEpisode} SeriesEpisode
 */

/**
 * Collapse whitespace (incl. non-breaking) and trim.
 *
 * @param {string | null | undefined} value Raw text.
 * @returns {string} Cleaned text.
 */
const cleanText = (value) =>
  (value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Split a comma-separated value string into a cleaned array.
 *
 * @param {string} value Raw comma-separated string.
 * @returns {string[]} Cleaned entries.
 */
const splitList = (value) =>
  cleanText(value).replace(/\.$/, '').split(',').map(cleanText).filter(Boolean);

/**
 * Extract the slug (last URL path segment) from a URL.
 *
 * @param {string} url URL to dissect.
 * @returns {string} Slug (empty when missing).
 */
const slugFromUrl = (url) =>
  (url || '').replace(/\/$/, '').split('/').pop() || '';

/**
 * Extract a background-image URL from an inline `style` attribute.
 *
 * @param {string | undefined} style Raw style attribute value.
 * @returns {string} Image URL or empty string.
 */
const parseBg = (style) =>
  style?.match(/url\((['"]?)(.*?)\1\)/)?.[2] || '';

/**
 * Parse a series/hentai page HTML and extract structured metadata.
 *
 * @param {string} html  Raw HTML body for a `/hentai/<slug>/` page.
 * @param {string} pageUrl Absolute URL the HTML was fetched from; used
 *   to resolve relative `href` values.
 * @returns {SeriesPageData} Parsed series data.
 */
export function parseSeriesPageHtml(html, pageUrl) {
  const $ = load(html);

  /** @type {SeriesPageData} */
  const data = {};

  // ======================
  // META
  // ======================
  const metaRoot = $('.nk-series-meta-list');

  if (metaRoot.length) {
    metaRoot.find('li').each((_, liEl) => {
      const li = $(liEl);
      const label = cleanText(li.find('b').first().text()).toLowerCase();
      const raw = cleanText(
        li.text().replace(li.find('b').first().text() || '', ''),
      )
        .replace(/^:/, '')
        .trim();

      if (label === 'genre') {
        /** @type {SeriesGenre[]} */
        const genres = [];
        li.find('a').each((_unused, aEl) => {
          const a = $(aEl);
          const rawHref = a.attr('href') ?? '';
          const href = rawHref ? new URL(rawHref, pageUrl).toString() : '';
          genres.push({
            name: cleanText(a.text()),
            slug: slugFromUrl(href),
            url: href,
          });
        });
        if (genres.length) data.genre = genres;
        return;
      }

      if (label === 'produser' || label === 'producers') {
        data.producers = splitList(raw);
        return;
      }

      if (label === 'judul jepang') {
        data.japaneseTitle = raw;
        return;
      }

      if (label === 'jenis') {
        data.type = raw;
        return;
      }

      if (label === 'episode') {
        data.totalEpisodes = Number(raw) || raw;
        return;
      }

      if (label === 'status') {
        data.status = raw;
        return;
      }

      if (label === 'tayang') {
        data.aired = raw;
        return;
      }

      if (label === 'durasi') {
        data.duration = raw;
        return;
      }

      if (label === 'skor') {
        data.score = Number(raw) || raw;
        return;
      }
    });
  }

  // ======================
  // EPISODES
  // ======================
  const epRoot = $('.nk-episode-grid');

  if (epRoot.length) {
    /** @type {SeriesEpisode[]} */
    const episodes = [];

    epRoot.find('li a.nk-episode-card').each((_, aEl) => {
      const a = $(aEl);
      const rawHref = a.attr('href') ?? '';
      const href = rawHref ? new URL(rawHref, pageUrl).toString() : '';
      const thumbEl = a.find('.nk-episode-card-thumb').first();
      const info = a.find('.nk-episode-card-info').first();

      const episode = {
        title: cleanText(
          info.find('.nk-episode-card-title').first().text(),
        ),
        url: href,
        slug: slugFromUrl(href),
        episode: cleanText(
          a.find('.nk-episode-badge').first().text(),
        ),
        date: cleanText(
          info.find('.nk-episode-card-date').first().text(),
        ),
        thumbnail: parseBg(
          thumbEl.attr('style'),
        ),
      };

      if (episode.url) episodes.push(episode);
    });

    if (episodes.length) data.episodes = episodes;
  }

  // ======================
  // SYNOPSIS
  // ======================
  const detailRoot = $('.nk-series-detail');

  if (detailRoot.length) {
    /** @type {string[]} */
    const paragraphs = [];
    detailRoot.find('.nk-series-synopsis > p').each((_, pEl) => {
      const text = cleanText($(pEl).text());
      if (text) paragraphs.push(text);
    });

    if (paragraphs.length) {
      data.synopsis = paragraphs.join('\n\n');
    }
  }

  return data;
}
