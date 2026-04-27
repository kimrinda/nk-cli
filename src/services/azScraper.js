/**
 * @file Scraper for the `/category/hentai-list` A–Z index page.
 *
 * Unlike the listing-style categories, the index page is a single
 * document containing every entry organised under letter groups, so
 * there is no pagination and no follow-up detail-page phase. The
 * tooltip card already carries title/genre/producer metadata.
 */

import { config } from '../config/index.js';
import { newConfiguredPage } from '../browser/launcher.js';
import {
  clickMenuByText,
  hasMenuByText,
} from '../parsers/pageItems.js';
import { parseAzList } from '../parsers/azList.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { writeJson, writeJsonSync } from '../utils/storage.js';
import { onShutdown } from '../utils/shutdown.js';

/**
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 * @typedef {import('../parsers/azList.js').AzGroup} AzGroup
 */

/**
 * Final A–Z index payload persisted to disk.
 *
 * @typedef {object} AzIndex
 * @property {string} category Category key.
 * @property {string} url URL of the index page.
 * @property {string} scrapedAt ISO 8601 timestamp.
 * @property {number} totalGroups Number of letter groups encountered.
 * @property {number} totalItems Sum of items across every group.
 * @property {Record<string, AzGroup>} groups Groups keyed by letter index.
 */

/**
 * Wait for the A–Z index DOM to render. Acts as the WAF gate signal.
 *
 * @param {import('puppeteer').Page} page Page navigated to the index URL.
 * @returns {Promise<void>} Resolves once the index container is present.
 */
async function waitForAzDom(page) {
  await page.waitForFunction(
    () => Boolean(document.querySelector('#nk-az-list .nk-az-group')),
    { timeout: config.browser.wafTimeoutMs, polling: 250 },
  );
}

/**
 * Navigate from the homepage to the AZ index landing page by clicking
 * the corresponding menu link.
 *
 * @param {import('puppeteer').Page} page Configured Puppeteer page.
 * @param {ResolvedCategory} category Category descriptor (must have `kind === 'azIndex'`).
 * @returns {Promise<void>} Resolves once the AZ DOM is rendered.
 */
async function enterAzCategory(page, category) {
  logger.info('Opening homepage', {
    url: config.homeUrl,
    category: category.key,
  });
  await page.goto(config.homeUrl, {
    waitUntil: 'networkidle2',
    timeout: config.browser.wafTimeoutMs,
  });

  logger.debug('Waiting for menu link', {
    menuText: category.menuText,
    timeoutMs: config.browser.wafTimeoutMs,
  });
  await page.waitForFunction(hasMenuByText, {
    timeout: config.browser.wafTimeoutMs,
    polling: 250,
  }, category.menuText);

  logger.info('Clicking menu link', {
    menuText: category.menuText,
    label: category.label,
  });
  await Promise.all([
    page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: config.browser.wafTimeoutMs,
    }),
    page.evaluate(clickMenuByText, category.menuText),
  ]);

  await waitForAzDom(page);
}

/**
 * Scrape the A–Z index for the supplied category and write the result
 * to `category.listingPath` (e.g. `output/hanimeIndex.json`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ResolvedCategory} category Category to scrape (must be an `azIndex`).
 * @returns {Promise<AzIndex>} Combined index payload.
 */
export async function scrapeAzIndex(browser, category) {
  if (category.kind !== 'azIndex') {
    throw new Error(
      `scrapeAzIndex: category "${category.key}" is not an azIndex target`,
    );
  }

  const page = await newConfiguredPage(browser);

  /** @type {AzIndex} */
  let payload = {
    category: category.key,
    url: '',
    scrapedAt: new Date().toISOString(),
    totalGroups: 0,
    totalItems: 0,
    groups: {},
  };

  /**
   * Persist the current payload synchronously. Used for the shutdown
   * hook — async writes risk losing data when the process exits.
   *
   * @returns {void}
   */
  const saveSync = () => writeJsonSync(category.listingPath, payload);
  onShutdown(saveSync);

  try {
    await withRetry(() => enterAzCategory(page, category), {
      attempts: config.scrape.retryAttempts,
      baseDelayMs: config.scrape.retryBaseDelayMs,
      label: `enterAzCategory(${category.key})`,
    });

    const groups = /** @type {Record<string, AzGroup>} */ (
      await page.evaluate(parseAzList)
    );
    const groupKeys = Object.keys(groups);
    const totalItems = groupKeys.reduce(
      (sum, key) => sum + (groups[key]?.items?.length ?? 0),
      0,
    );

    payload = {
      ...payload,
      url: page.url(),
      scrapedAt: new Date().toISOString(),
      totalGroups: groupKeys.length,
      totalItems,
      groups,
    };

    await writeJson(category.listingPath, payload);

    logger.info('A–Z index scrape complete', {
      category: category.key,
      groups: payload.totalGroups,
      items: payload.totalItems,
      file: category.listingPath,
    });

    return payload;
  } finally {
    await page.close().catch(() => undefined);
  }
}
