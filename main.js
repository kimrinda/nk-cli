#!/usr/bin/env node
/**
 * @file Entry point for the nk-cli scraper.
 *
 * Dispatches the user-supplied CLI command to the matching scraper
 * pipeline and installs graceful shutdown hooks.
 *
 * Usage:
 *   node main.js scrape:hanime
 *   node main.js scrape:2d-animation
 *   node main.js scrape:3d-hentai
 *   node main.js scrape:jav-cosplay
 *   node main.js scrape:jav
 *   node main.js scrape:hanimeindex
 *   node main.js scrape:info --slug <slug> [--category <key>]
 *   node main.js scrape:info --page <category-key>
 */

// Load `.env` (if present) before any other module reads `process.env`.
import 'dotenv/config';

import { closeBrowser, launchBrowser } from './src/browser/launcher.js';
import { parseArgs } from './src/cli/parser.js';
import { confirmDetailScrape } from './src/cli/prompt.js';
import { getCategory } from './src/config/categories.js';
import { config } from './src/config/index.js';
import {
  scrapeDetails,
  scrapeSingleDetail,
} from './src/services/detailScraper.js';
import { scrapeListing } from './src/services/listingScraper.js';
import { scrapeAzIndex } from './src/services/azScraper.js';
import { logger } from './src/utils/logger.js';
import { readJson } from './src/utils/storage.js';
import { installShutdownHooks } from './src/utils/shutdown.js';

/**
 * @typedef {import('./src/cli/parser.js').CliAction} CliAction
 * @typedef {import('./src/parsers/pageItems.js').ListingItem} ListingItem
 */

/**
 * Run a `listing` action: scrape the listing pages and (when running
 * interactively or `NK_AUTO_DETAIL=yes`) follow up with the detail
 * phase after asking the user for confirmation.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @returns {Promise<void>} Resolves when the action is fully done.
 */
async function runListingAction(browser, category) {
  const items = await scrapeListing(browser, category);
  logger.info('Listing phase finished', {
    category: category.key,
    items: items.length,
    file: category.listingPath,
  });

  const proceed = await confirmDetailScrape({
    label: category.label,
    itemCount: items.length,
  });
  if (!proceed) {
    logger.info('Detail phase skipped by user / non-interactive default', {
      category: category.key,
    });
    return;
  }
  if (!items.length) {
    logger.warn('No listing items collected — skipping detail phase', {
      category: category.key,
    });
    return;
  }
  await scrapeDetails(browser, category, items);
}

/**
 * Run an `azIndex` action (e.g. `scrape:hanimeindex`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @returns {Promise<void>} Resolves when the index has been written.
 */
async function runAzAction(browser, category) {
  const result = await scrapeAzIndex(browser, category);
  logger.info('AZ index phase finished', {
    category: category.key,
    groups: result.totalGroups,
    items: result.totalItems,
    file: category.listingPath,
  });
}

/**
 * Run a `detailByPage` action (`scrape:info --page <category>`): load
 * a previously-saved listing JSON for the category and run the detail
 * phase against its entries.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @returns {Promise<void>} Resolves when the detail phase finishes.
 */
async function runDetailByPageAction(browser, category) {
  /** @type {ListingItem[]} */
  const items = await readJson(category.listingPath, []);
  logger.info('Loaded listing from disk', {
    category: category.key,
    count: items.length,
    file: category.listingPath,
  });
  if (!items.length) {
    logger.warn(
      'No listing entries found on disk — run the listing command first.',
      { category: category.key, file: category.listingPath },
    );
    return;
  }
  await scrapeDetails(browser, category, items);
}

/**
 * Run a `detailBySlug` action (`scrape:info --slug <slug>`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category context.
 * @param {string} slug Slug to scrape.
 * @returns {Promise<void>} Resolves once the single detail has been written.
 */
async function runDetailBySlugAction(browser, category, slug) {
  const record = await scrapeSingleDetail(browser, category, slug);
  logger.info('Single detail scrape finished', {
    slug: record.slug,
    url: record.url,
    file: category.detailPath,
  });
}

/**
 * Dispatch the resolved CLI action against a freshly-launched browser.
 *
 * @param {CliAction} action Parsed CLI intent.
 * @returns {Promise<void>} Resolves once the action is done.
 */
async function dispatch(action) {
  installShutdownHooks();
  const category = getCategory(action.categoryKey);
  logger.info('nk-cli scraper starting', {
    action: action.type,
    category: category.key,
    baseUrl: config.baseUrl,
    headless: config.browser.headless,
  });

  /** @type {import('puppeteer').Browser | null} */
  let browser = null;

  try {
    browser = await launchBrowser();

    switch (action.type) {
      case 'listing':
        await runListingAction(browser, category);
        break;
      case 'azIndex':
        await runAzAction(browser, category);
        break;
      case 'detailByPage':
        await runDetailByPageAction(browser, category);
        break;
      case 'detailBySlug':
        await runDetailBySlugAction(browser, category, action.slug);
        break;
      default: {
        /** @type {never} */
        const exhaustive = action;
        throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }

    logger.info('nk-cli scraper finished', { action: action.type });
  } finally {
    await closeBrowser(browser);
  }
}

/**
 * CLI entry. Wires the parser to {@link dispatch} and surfaces fatal
 * errors via the logger before exiting non-zero.
 *
 * @returns {Promise<void>} Never resolves on a fatal error (process exits).
 */
async function main() {
  try {
    const action = await parseArgs(process.argv);
    await dispatch(action);
  } catch (error) {
    logger.error('Fatal error in scraper', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

main();
