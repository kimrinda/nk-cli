/**
 * @file Cheerio (HTTP-mode) detail content-body parser.
 *
 * Parses the same `.konten` metadata block that the browser-mode
 * extractor in `src/parsers/contentBody.js` produces, but using a
 * static HTML tree loaded with cheerio.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../contentBody.js').ContentBody} ContentBody
 */

/**
 * Collapse whitespace (incl. non-breaking) and trim.
 *
 * @param {string | null | undefined} value Raw text value.
 * @returns {string} Cleaned value.
 */
function clean(value) {
  return (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the detail-page HTML and produce the same {@link ContentBody}
 * record shape as the browser-side extractor.
 *
 * @param {string} html Raw HTML body for the detail page.
 * @returns {ContentBody} Parsed content-body record (empty fields when
 *   the markup is missing).
 */
export function parseContentBodyHtml(html) {
  const $ = load(html);
  /** @type {ContentBody} */
  const data = {
    title: '',
    synopsis: '',
    genre: [],
    producers: [],
    duration: '',
    size: {},
    note: '',
    views: '',
    uploaded: '',
  };

  const konten = $('.konten').first();
  if (konten.length) {
    /** @type {string[]} */
    const rows = [];
    konten.find('p,h1,h2,h3,h4,h5,h6').each((_, el) => {
      const text = clean($(el).text());
      if (text) rows.push(text);
    });

    for (const row of rows) {
      const lower = row.toLowerCase();

      if (/^(judul|title)\s*:/.test(lower)) {
        data.title = row.replace(/^(judul|title)\s*:/i, '').trim();
        continue;
      }
      if (/^sinopsis/.test(lower)) continue;

      if (
        !data.synopsis &&
        row.length > 80 &&
        !/^(genre|producer|producers|duration|durasi|ukuran|size|catatan|judul)/i.test(
          row,
        )
      ) {
        data.synopsis = row.trim();
        continue;
      }
      if (/^(producer|producers)\s*:/.test(lower)) {
        data.producers = row
          .replace(/^(producer|producers)\s*:/i, '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        continue;
      }
      if (/^genre\s*:/.test(lower)) {
        data.genre = row
          .replace(/^genre\s*:/i, '')
          .replace(/\.$/, '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        continue;
      }
      if (/^(duration|durasi)\s*:/.test(lower)) {
        data.duration = row.replace(/^(duration|durasi)\s*:/i, '').trim();
        continue;
      }
      if (/^(size|ukuran)\s*:/.test(lower)) {
        const cleaned = row.replace(/^(size|ukuran)\s*:/i, '').trim();
        const matches = [
          ...cleaned.matchAll(/(\d{3,4}P)\s*:\s*([\d.,]+\s*[a-z]+)/gi),
        ];
        for (const m of matches) {
          data.size[m[1].toUpperCase()] = m[2].trim();
        }
        continue;
      }
      if (/^catatan\s*:/.test(lower)) {
        data.note = row.replace(/^catatan\s*:/i, '').trim();
      }
    }
  }

  const headerTitle = clean($('.nk-post-header > h1').first().text());
  if (headerTitle) data.title = headerTitle;

  const headerMeta = $('.nk-post-header-meta').first();
  if (headerMeta.length) {
    const visibility = headerMeta.find('span[class*="visibility"]').first();
    if (visibility.length) {
      const sibling = visibility[0].nextSibling;
      if (sibling && 'data' in sibling) {
        data.views = clean(/** @type {{data: string}} */ (sibling).data);
      }
    }
    const calendar = headerMeta.find('span[class*="calendar"]').first();
    if (calendar.length) {
      const sibling = calendar[0].nextSibling;
      if (sibling && 'data' in sibling) {
        data.uploaded = clean(/** @type {{data: string}} */ (sibling).data);
      }
    }
  }

  return data;
}
