#!/usr/bin/env node
/**
 * @file Entry point for the nk-cli scraper.
 *
 * Orchestrates the listing and detail scrape phases, installs graceful
 * shutdown hooks, and ensures the browser is always closed even when
 * the run is aborted.
 *
 * Usage:
 *   node main.js                # full run: listing + details
 *   node main.js --only=list    # listing only
 *   node main.js --only=detail  # details only (uses existing list file)
 */

import { config } from './src/config/index.js';
import { closeBrowser, launchBrowser } from './src/browser/launcher.js';
import { scrapeListing } from './src/services/listingScraper.js';
import { scrapeDetails } from './src/services/detailScraper.js';
import { logger } from './src/utils/logger.js';
import { readJson } from './src/utils/storage.js';
import { installShutdownHooks } from './src/utils/shutdown.js';

/**
 * Parsed CLI flags consumed by {@link run}.
 *
 * @typedef {object} CliArgs
 * @property {'all'|'list'|'detail'} only Which phase(s) to execute.
 */

/**
 * Parse the supported CLI flags from `process.argv`.
 *
 * @param {string[]} argv Raw argv slice (`process.argv.slice(2)`).
 * @returns {CliArgs} Normalised CLI arguments.
 */
function parseArgs(argv) {
  /** @type {CliArgs} */
  const args = { only: 'all' };
  for (const token of argv) {
    if (token.startsWith('--only=')) {
      const value = token.slice('--only='.length);
      if (value === 'list' || value === 'detail' || value === 'all') {
        args.only = value;
      }
    }
  }
  return args;
}

/**
 * Execute the requested scrape phases end-to-end.
 *
 * @param {CliArgs} args Parsed CLI flags.
 * @returns {Promise<void>} Resolves once every requested phase finishes.
 */
async function run(args) {
  installShutdownHooks();
  logger.info('nk-cli scraper starting', {
    phase: args.only,
    baseUrl: config.baseUrl,
    headless: config.browser.headless,
  });

  /** @type {import('puppeteer').Browser | null} */
  let browser = null;

  try {
    browser = await launchBrowser();

    /** @type {import('./src/parsers/pageItems.js').ListingItem[]} */
    let items = [];

    if (args.only === 'list' || args.only === 'all') {
      items = await scrapeListing(browser);
    } else {
      items = await readJson(config.paths.listingFile, []);
      logger.info('Loaded listing from disk', {
        count: items.length,
        path: config.paths.listingFile,
      });
    }

    if (args.only === 'detail' || args.only === 'all') {
      if (!items.length) {
        logger.warn('No listing items found — skipping detail phase');
      } else {
        await scrapeDetails(browser, items);
      }
    }

    logger.info('nk-cli scraper finished');
  } finally {
    await closeBrowser(browser);
  }
}

run(parseArgs(process.argv.slice(2))).catch((error) => {
  logger.error('Fatal error in scraper', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
