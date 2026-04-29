/**
 * @file Cheerio (HTTP-mode) featured-image srcset parser.
 *
 * Mirrors the browser-side parser in `src/parsers/featuredImage.js` but
 * operates on a static HTML string loaded with cheerio.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../featuredImage.js').ImageSource} ImageSource
 * @typedef {import('../featuredImage.js').FeaturedImageData} FeaturedImageData
 */

/**
 * Parse the `srcset` attribute of `.nk-featured-img img` from an HTML
 * string and return a structured {@link FeaturedImageData} object.
 *
 * @param {string} html Raw HTML body for the detail page.
 * @returns {FeaturedImageData | null} Image data or `null` when the
 *   element is not found.
 */
export function parseFeaturedImageHtml(html) {
  const $ = load(html);
  const img = $('.nk-featured-img img').first();
  if (!img.length) return null;

  const src = img.attr('src') || '';
  const srcset = img.attr('srcset') || '';

  /** @type {ImageSource[]} */
  const sources = srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(https?:\/\/\S+)\s+(\d+)w$/i);
      if (!match) return null;
      return { url: match[1], width: Number(match[2]) };
    })
    .filter(/** @type {(v: ImageSource | null) => v is ImageSource} */ (Boolean))
    .sort((a, b) => a.width - b.width);

  return {
    src,
    currentSrc: src,
    largest: sources.length ? sources[sources.length - 1].url : src,
    smallest: sources.length ? sources[0].url : src,
    sources,
  };
}
