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
 * Locate the homepage menu link whose visible text matches `menuText`
 * (case-insensitive, whitespace-collapsed) and click it.
 *
 * Searches every `li > a` so it works for both top-level menu items and
 * dropdown children. Click is dispatched even if the parent submenu is
 * still collapsed — programmatic `.click()` does not require visibility.
 *
 * @param {string} menuText Target menu text (e.g. "Hentai", "2D Animation").
 * @returns {boolean} True when a matching link was clicked.
 */
export function clickMenuByText(menuText) {
  const target = (menuText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const link = [...document.querySelectorAll('li > a')].find((anchor) => {
    const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text === target;
  });
  if (link instanceof HTMLElement) {
    link.click();
    return true;
  }
  return false;
}

/**
 * Test whether the menu link with the given text is rendered.
 *
 * Mirrors {@link clickMenuByText}'s normalisation rules so the wait
 * predicate and the click match the exact same anchor.
 *
 * @param {string} menuText Target menu text.
 * @returns {boolean} True when the link is present in the DOM.
 */
export function hasMenuByText(menuText) {
  const target = (menuText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [...document.querySelectorAll('li > a')].some((anchor) => {
    const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text === target;
  });
}

/**
 * Backwards-compatible alias for {@link clickMenuByText} bound to the
 * Hentai menu. Retained so existing callers and tests keep working.
 *
 * @returns {boolean} True when the Hentai menu was clicked.
 */
export function clickHentaiMenu() {
  return clickMenuByText('hentai');
}
