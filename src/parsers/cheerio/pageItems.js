/**
 * @file Cheerio (HTTP-mode) listing parser, mirroring the DOM-based
 * `src/parsers/pageItems.js` extractor but operating on a parsed HTML
 * tree from `axios + cheerio` instead of a live Puppeteer page.
 *
 * The output shape is intentionally identical to
 * {@link import('../pageItems.js').ListingItem} so downstream callers
 * can treat both modes uniformly.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../pageItems.js').ListingItem} ListingItem
 */

/**
 * Parse the listing-page HTML and return its visible items.
 *
 * @param {string} html Raw HTML body for a `/category/<slug>` page.
 * @param {string} pageUrl Absolute URL the HTML was fetched from. Used
 *   to resolve relative `href` values back into absolute URLs.
 * @returns {ListingItem[]} Listing items (deduplicated via slug at the
 *   call-site, not here).
 */
export function parsePageItemsHtml(html, pageUrl) {
  const $ = load(html);
  /** @type {ListingItem[]} */
  const items = [];

  $('.nk-search-results li').each((_, el) => {
    const li = $(el);
    const anchor = li.find('a').first();
    const rawHref = anchor.attr('href') ?? '';
    const href = rawHref ? new URL(rawHref, pageUrl).toString() : '';
    const slug = href ? href.replace(/\/$/, '').split('/').pop() ?? '' : '';
    const style = li.find('.nk-search-thumb').attr('style') ?? '';
    const thumbnail = style.match(/url\((['"]?)(.*?)\1\)/)?.[2] ?? '';
    const title = li.find('.nk-search-info > h2').first().text().trim();
    if (slug) {
      items.push({ slug, title, thumbnail, url: href });
    }
  });

  return items;
}

/**
 * Resolve the absolute URL of the next listing page, if any.
 *
 * @param {string} html Raw HTML body for a listing page.
 * @param {string} pageUrl Absolute URL of the page being inspected.
 * @returns {string | null} Absolute URL of the next page, or `null`
 *   when no `.next.page-numbers` link is present.
 */
export function nextListingUrl(html, pageUrl) {
  const $ = load(html);
  const next = $('a.next.page-numbers').first();
  const href = next.attr('href');
  if (!href) return null;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}
