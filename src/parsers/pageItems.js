/**
 * @file Listing-page parser for `/category/hentai` result lists.
 *
 * Exposes a single function that runs **inside the page context** via
 * `page.evaluate(...)`, returning the slug/title/thumbnail tuples for the
 * 10 items present on the current listing page.
 */

/**
 * Listing entry produced for each `<li>` in `.nk-search-results`.
 *
 * @typedef {object} ListingItem
 * @property {string} slug Last URL segment used to build the detail URL.
 * @property {string} title Trimmed item title.
 * @property {string} thumbnail Background-image URL extracted from CSS.
 * @property {string} url Absolute detail URL.
 */

/**
 * Browser-side extractor for the current listing page.
 *
 * The function is serialised by Puppeteer; it must remain self-contained
 * and reference no Node imports.
 *
 * @returns {ListingItem[]} The items rendered on the current page.
 */
export function getPageItems() {
  const items = [...document.querySelectorAll('.nk-search-results li')];

  return items
    .map((item) => {
      const anchor = item.querySelector('a');
      const href = anchor?.href ?? '';
      const slug = href ? href.replace(/\/$/, '').split('/').pop() ?? '' : '';
      const thumbEl = item.querySelector('.nk-search-thumb');
      const bg =
        thumbEl instanceof HTMLElement
          ? thumbEl.style.backgroundImage
          : '';
      const thumbnail = bg.match(/url\((['"]?)(.*?)\1\)/)?.[2] ?? '';
      const title = item
        .querySelector('.nk-search-info > h2')
        ?.textContent?.trim() ?? '';

      return { slug, title, thumbnail, url: href };
    })
    .filter((item) => item.slug);
}

/**
 * Detect whether a "next page" pagination link is present.
 *
 * @returns {boolean} True if the listing has more pages to scrape.
 */
export function hasNextPage() {
  return Boolean(document.querySelector('.next.page-numbers'));
}

/**
 * Click the "next page" pagination link, if it exists.
 *
 * @returns {boolean} True when a click was dispatched.
 */
export function clickNextPage() {
  const next = document.querySelector('.next.page-numbers');
  if (next instanceof HTMLElement) {
    next.click();
    return true;
  }
  return false;
}

/**
 * Locate the homepage menu link whose text reads "Hentai" (case-insensitive)
 * and click it. Returns whether the click was successful.
 *
 * @returns {boolean} True when the Hentai menu was clicked.
 */
export function clickHentaiMenu() {
  const link = [...document.querySelectorAll('li > a')].find(
    (anchor) => anchor.textContent?.toLowerCase().trim() === 'hentai',
  );
  if (link instanceof HTMLElement) {
    link.click();
    return true;
  }
  return false;
}
