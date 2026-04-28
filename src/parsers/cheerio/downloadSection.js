/**
 * @file Cheerio (HTTP-mode) `.nk-download-section` parser.
 *
 * Mirrors `src/parsers/downloadSection.js` but operates on a static
 * HTML tree parsed by cheerio.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../downloadSection.js').DownloadRow} DownloadRow
 * @typedef {import('../downloadSection.js').DownloadLink} DownloadLink
 */

/**
 * Parse a detail page's download section.
 *
 * @param {string} html Raw HTML body for the detail page.
 * @param {string} pageUrl Absolute URL of the page (used to resolve
 *   relative `href` values).
 * @returns {DownloadRow[]} Parsed rows. Empty when the section is absent.
 */
export function parseDownloadSectionHtml(html, pageUrl) {
  const $ = load(html);
  const section = $('.nk-download-section').first();
  if (!section.length) return [];

  /** @type {DownloadRow[]} */
  const rows = [];
  section.find('.nk-download-row').each((_, rowEl) => {
    const row = $(rowEl);
    const name = row
      .find('.nk-download-name')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const resolution =
      name.match(/\[(\d{3,4}p)\]/i)?.[1]?.toUpperCase() ?? '';
    /** @type {DownloadLink[]} */
    const links = [];
    row.find('.nk-download-links a').each((_unused, linkEl) => {
      const link = $(linkEl);
      const host = (link.text() || '').replace(/\s+/g, ' ').trim();
      const rawHref = link.attr('href') ?? '';
      if (!host || !rawHref) return;
      let url = rawHref;
      try {
        url = new URL(rawHref, pageUrl).toString();
      } catch {
        url = rawHref;
      }
      links.push({ host, url });
    });
    if (name || links.length) {
      rows.push({ name, resolution, links });
    }
  });
  return rows;
}
