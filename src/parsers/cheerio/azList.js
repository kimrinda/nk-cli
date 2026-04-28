/**
 * @file Cheerio (HTTP-mode) parser for the `/category/hentai-list` A–Z
 * index page. Mirrors `src/parsers/azList.js` but works against a
 * static HTML tree loaded with cheerio.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../azList.js').AzGroup} AzGroup
 * @typedef {import('../azList.js').AzItem} AzItem
 * @typedef {import('../azList.js').TooltipCard} TooltipCard
 */

/**
 * Collapse whitespace (incl. non-breaking) and trim.
 *
 * @param {string | null | undefined} value Raw text.
 * @returns {string} Cleaned text.
 */
function clean(value) {
  return (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the slug (last URL path segment) from an absolute URL.
 *
 * @param {string} url URL to dissect.
 * @returns {string} Slug (empty when missing).
 */
function slugFromUrl(url) {
  return (url || '').replace(/\/$/, '').split('/').pop() || '';
}

/**
 * Parse the HTML payload stored on `original-title`/`title` attributes
 * into a structured tooltip card.
 *
 * @param {string} html Raw HTML payload.
 * @returns {TooltipCard | null} Structured card or null on failure.
 */
function parseTooltipCard(html) {
  if (!html) return null;
  const $$ = load(html);
  const card = $$('.nk-tooltip-card').first();
  if (!card.length) return null;

  const detailText = clean(card.find('.nk-tooltip-detail').first().text());

  /**
   * Pull a label-prefixed field out of the flattened tooltip text.
   *
   * @param {string} label Label regex source (alternation OK).
   * @returns {string} Cleaned value (empty when missing).
   */
  function getField(label) {
    const match = detailText.match(
      new RegExp(
        `(?:${label})\\s*:\\s*(.*?)(?=\\s*(?:Nama Jepang|Produser|Producer|Tipe|Status|Genre|Durasi|Duration|Skor|Score)\\s*:|$)`,
        'i',
      ),
    );
    return clean(match ? match[1] : '');
  }

  const producersField = getField('Produser|Producer');
  const genreField = getField('Genre');

  return {
    title: clean(card.find('h2').first().text()),
    image: card.find('img').first().attr('src') || '',
    japaneseName: getField('Nama Jepang'),
    producers: producersField
      ? producersField.split(',').map(clean).filter(Boolean)
      : [],
    type: getField('Tipe'),
    status: getField('Status'),
    genre: genreField
      ? genreField.split(',').map(clean).filter(Boolean)
      : [],
    duration: getField('Durasi|Duration'),
    score: getField('Skor|Score'),
  };
}

/**
 * Parse the A–Z index page HTML.
 *
 * @param {string} html Raw HTML body for the index page.
 * @param {string} pageUrl Absolute URL of the page (used to resolve
 *   relative `href` values).
 * @returns {Record<string, AzGroup>} Groups keyed by letter index.
 */
export function parseAzListHtml(html, pageUrl) {
  const $ = load(html);
  const root = $('#nk-az-list').first();
  if (!root.length) return {};

  /** @type {Record<string, AzGroup>} */
  const result = {};

  root.find('.nk-az-group').each((_, groupEl) => {
    const group = $(groupEl);
    const letterAnchor = group.find('.nk-az-letter a').first();
    const letterText = group.find('.nk-az-letter').first();
    const index = clean(
      letterAnchor.attr('name') || letterText.text() || '',
    );

    /** @type {AzItem[]} */
    const items = [];
    group.find('.nk-az-item a').each((_unused, aEl) => {
      const a = $(aEl);
      const rawHref = a.attr('href') || '';
      let url = rawHref;
      try {
        url = rawHref ? new URL(rawHref, pageUrl).toString() : '';
      } catch {
        url = rawHref;
      }
      const tooltipHtml =
        a.attr('original-title') ||
        a.attr('data-original-title') ||
        a.attr('title') ||
        '';
      items.push({
        id: a.attr('rel') || '',
        title: clean(a.text()),
        slug: slugFromUrl(url),
        url,
        tooltip: parseTooltipCard(tooltipHtml),
      });
    });

    if (index) {
      result[index] = { index, count: items.length, items };
    }
  });

  return result;
}
