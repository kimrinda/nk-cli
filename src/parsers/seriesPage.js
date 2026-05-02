/**
 * @file Browser-side parser for hanimeindex series pages.
 *
 * Extracts structured metadata from the `.nk-series-meta-list` and
 * episode listings from `.nk-episode-grid`. The output is stored
 * inline in the `hanimeIndex.json` under `groups.X.items[N].details`.
 *
 * This function runs **inside the page context** via
 * `page.evaluate(...)` and must remain self-contained.
 */

/**
 * Genre link entry found in the meta list.
 *
 * @typedef {object} SeriesGenre
 * @property {string} name  Display name.
 * @property {string} slug  URL-derived slug.
 * @property {string} url   Absolute URL of the genre page.
 */

/**
 * Single episode entry from the episode grid.
 *
 * @typedef {object} SeriesEpisode
 * @property {string} title    Episode title.
 * @property {string} url      Absolute URL.
 * @property {string} slug     URL-derived slug.
 * @property {string} episode  Episode badge text (e.g. "01").
 * @property {string} date     Release date text.
 * @property {string} thumbnail Thumbnail background-image URL.
 */

/**
 * Combined series page data.
 *
 * @typedef {object} SeriesPageData
 * @property {SeriesGenre[]}   [genre]         Genre tag links.
 * @property {string[]}        [producers]     Producer names.
 * @property {string}          [japaneseTitle]  Japanese title.
 * @property {string}          [type]          Content type.
 * @property {number|string}   [totalEpisodes] Episode count.
 * @property {string}          [status]        Airing status.
 * @property {string}          [aired]         Air date.
 * @property {string}          [duration]      Duration text.
 * @property {number|string}   [score]         Score value.
 * @property {string}          [synopsis]      Synopsis text (paragraphs joined by newlines).
 * @property {SeriesEpisode[]} [episodes]      Episode list.
 */

/**
 * Browser-side extractor for the series/hentai page.
 *
 * Adapted from the user-supplied `parseSeriesPage` reference
 * implementation. Runs in the Puppeteer page context.
 *
 * @returns {SeriesPageData} Parsed series data.
 */
export function parseSeriesPage() {
  /** @param {string | null | undefined} v */
  const cleanText = (v) =>
    (v || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** @param {string} v */
  const splitList = (v) =>
    cleanText(v).replace(/\.$/, '').split(',').map(cleanText).filter(Boolean);

  /** @param {string} url */
  const slugFromUrl = (url) =>
    (url || '').replace(/\/$/, '').split('/').pop();

  /** @param {string | null | undefined} style */
  const parseBg = (style) =>
    style?.match(/url\((['"]?)(.*?)\1\)/)?.[2] || '';

  /** @type {SeriesPageData} */
  const data = {};

  // ======================
  // META
  // ======================
  const metaRoot = document.querySelector('.nk-series-meta-list');

  if (metaRoot) {
    [...metaRoot.querySelectorAll('li')].forEach((li) => {
      const label = cleanText(
        li.querySelector('b')?.textContent,
      ).toLowerCase();

      const raw = cleanText(
        li.textContent.replace(
          li.querySelector('b')?.textContent || '',
          '',
        ),
      )
        .replace(/^:/, '')
        .trim();

      if (label === 'genre') {
        const genres = [...li.querySelectorAll('a')].map((a) => ({
          name: cleanText(a.textContent),
          slug: slugFromUrl(a.href),
          url: a.href,
        }));
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
  const epRoot = document.querySelector('.nk-episode-grid');

  if (epRoot) {
    const episodes = [...epRoot.querySelectorAll('li a.nk-episode-card')]
      .map((a) => {
        const thumbEl = a.querySelector('.nk-episode-card-thumb');
        const info = a.querySelector('.nk-episode-card-info');

        return {
          title: cleanText(
            info?.querySelector('.nk-episode-card-title')?.textContent,
          ),
          url: /** @type {HTMLAnchorElement} */ (a).href,
          slug: slugFromUrl(/** @type {HTMLAnchorElement} */ (a).href),
          episode: cleanText(
            a.querySelector('.nk-episode-badge')?.textContent,
          ),
          date: cleanText(
            info?.querySelector('.nk-episode-card-date')?.textContent,
          ),
          thumbnail: parseBg(
            thumbEl?.getAttribute('style'),
          ),
        };
      })
      .filter((x) => x.url);

    if (episodes.length) data.episodes = episodes;
  }

  // ======================
  // SYNOPSIS
  // ======================
  const detailRoot = document.querySelector('.nk-series-detail');

  if (detailRoot) {
    const paragraphs = [
      ...detailRoot.querySelectorAll('.nk-series-synopsis > p'),
    ]
      .map((p) => cleanText(p.textContent))
      .filter(Boolean);

    if (paragraphs.length) {
      data.synopsis = paragraphs.join('\n\n');
    }
  }

  return data;
}
