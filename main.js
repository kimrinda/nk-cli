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
import {
  confirmDetailScrape,
  confirmOverwrite,
  confirmResume,
} from './src/cli/prompt.js';
import { getCategory } from './src/config/categories.js';
import { config } from './src/config/index.js';
import { scrapeDetails } from './src/services/detailScraper.js';
import { scrapeListing } from './src/services/listingScraper.js';
import { scrapeAzIndex } from './src/services/azScraper.js';
import { logger } from './src/utils/logger.js';
import { readJson } from './src/utils/storage.js';
import {
  installShutdownHooks,
  isShutdownInProgress,
  onShutdownAsync,
  requestShutdown,
} from './src/utils/shutdown.js';
import {
  ProgressManager,
  negotiateResume,
} from './src/utils/progressManager.js';

/**
 * @typedef {import('./src/cli/parser.js').CliAction} CliAction
 * @typedef {import('./src/parsers/pageItems.js').ListingItem} ListingItem
 */

/**
 * Resolve the canonical (command, output file) pair for a CLI action.
 *
 * The pair drives the resume-progress meta lookup so an interrupted
 * `scrape:hanime` only matches against another `scrape:hanime` run
 * later — never an unrelated category's leftovers.
 *
 * @param {CliAction} action Parsed CLI intent.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @returns {{ command: string, outputFile: string }} Pair used by
 *   {@link negotiateResume}.
 */
function resolveProgressTarget(action, category) {
  switch (action.type) {
    case 'listing':
      return {
        command: `scrape:${category.key}:listing`,
        outputFile: category.listingPath,
      };
    case 'azIndex':
      return {
        command: `scrape:${category.key}:az`,
        outputFile: category.listingPath,
      };
    case 'detailByPage':
    case 'detailBySlug': {
      if (!category.detailPath) {
        throw new Error(
          `Category "${category.key}" has no detail output configured`,
        );
      }
      return {
        command: `scrape:${category.key}:detail`,
        outputFile: category.detailPath,
      };
    }
    default: {
      /** @type {never} */
      const exhaustive = action;
      throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Negotiate a {@link ResumeDecision} for the current action and either
 * return a configured {@link ProgressManager} (with a starting index) or
 * trigger a graceful shutdown when the user cancels.
 *
 * @param {CliAction} action Parsed CLI intent.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @returns {Promise<{ progress: ProgressManager, startIndex: number }>}
 *   Manager + starting index; never returns when the user cancels.
 */
async function negotiateAndPrepareProgress(action, category) {
  const target = resolveProgressTarget(action, category);

  const decision = await negotiateResume({
    command: target.command,
    outputFile: target.outputFile,
    confirmResume,
    confirmOverwrite,
  });

  if (decision.action === 'cancel') {
    logger.warn('User cancelled scrape via resume prompt — exiting', {
      command: target.command,
    });
    await requestShutdown('user-cancel', 0);
    // Should never reach here.
    throw new Error('cancelled');
  }

  const progress = new ProgressManager({
    command: target.command,
    outputFile: target.outputFile,
  });

  if (decision.action === 'resume' && decision.previous) {
    await progress.adopt(decision.previous);
    logger.info('Resuming from previous progress meta', {
      command: target.command,
      lastCompletedIndex: decision.previous.lastCompletedIndex,
      totalItems: decision.previous.totalItems,
    });
  } else {
    await progress.init({});
    logger.info('Starting fresh scrape (no resume)', {
      command: target.command,
    });
  }

  return { progress, startIndex: decision.startIndex };
}

/**
 * Run a `listing` action: scrape the listing pages and (when running
 * interactively or `NK_AUTO_DETAIL=yes`) follow up with the detail
 * phase after asking the user for confirmation.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume
 *   Listing-phase progress + resume index.
 * @returns {Promise<void>} Resolves when the action is fully done.
 */
async function runListingAction(browser, category, resume) {
  const items = await scrapeListing(browser, category, {
    progress: resume.progress,
    startPage: resume.startIndex + 1,
  });
  logger.info('Listing phase finished', {
    category: category.key,
    items: items.length,
    file: category.listingPath,
  });

  if (isShutdownInProgress()) return;

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

  // Run a separate resume negotiation for the follow-on detail phase
  // so its meta file (e.g. `<key>Details.progress.meta.json`) gets a
  // proper Yes/No/Cancel handshake of its own.
  const detailResume = await negotiateAndPrepareProgress(
    { type: 'detailByPage', categoryKey: category.key },
    category,
  );
  await scrapeDetails(browser, category, items, {
    progress: detailResume.progress,
    startIndex: detailResume.startIndex,
  });
}

/**
 * Run an `azIndex` action (e.g. `scrape:hanimeindex`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume
 *   AZ-phase progress + resume index.
 * @returns {Promise<void>} Resolves when the index has been written.
 */
async function runAzAction(browser, category, resume) {
  const result = await scrapeAzIndex(browser, category, {
    progress: resume.progress,
  });
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
 * @param {{ progress: ProgressManager, startIndex: number }} resume
 *   Detail-phase progress + resume index.
 * @returns {Promise<void>} Resolves when the detail phase finishes.
 */
async function runDetailByPageAction(browser, category, resume) {
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
  await scrapeDetails(browser, category, items, {
    progress: resume.progress,
    startIndex: resume.startIndex,
  });
}

/**
 * Run a `detailBySlug` action (`scrape:info --slug <slug>`).
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category context.
 * @param {string} slug Slug to scrape.
 * @param {{ progress: ProgressManager, startIndex: number }} resume
 *   Detail-phase progress + resume index.
 * @returns {Promise<void>} Resolves once the single detail has been written.
 */
async function runDetailBySlugAction(browser, category, slug, resume) {
  const items = [{ slug, title: '', thumbnail: '', url: '' }];
  const records = await scrapeDetails(browser, category, items, {
    progress: resume.progress,
    startIndex: resume.startIndex,
  });
  const record = records.find((entry) => entry.slug === slug);
  if (!record) {
    throw new Error(`scrapeSingleDetail: no record produced for ${slug}`);
  }
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

  // Negotiate resume *before* launching the browser so a "Cancel"
  // answer doesn't leak a Chromium process.
  const resume = await negotiateAndPrepareProgress(action, category);
  if (isShutdownInProgress()) return;

  /** @type {import('puppeteer').Browser | null} */
  let browser = null;

  // Register a best-effort browser closer with the shutdown manager so
  // SIGINT/SIGTERM never leaves Chromium dangling.
  onShutdownAsync(async () => {
    if (browser) {
      logger.info('Closing browser during shutdown');
      await closeBrowser(browser);
      browser = null;
    }
  });

  try {
    browser = await launchBrowser();

    switch (action.type) {
      case 'listing':
        await runListingAction(browser, category, resume);
        break;
      case 'azIndex':
        await runAzAction(browser, category, resume);
        break;
      case 'detailByPage':
        await runDetailByPageAction(browser, category, resume);
        break;
      case 'detailBySlug':
        await runDetailBySlugAction(browser, category, action.slug, resume);
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
    browser = null;
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
    if (error instanceof Error && error.message === 'cancelled') {
      // requestShutdown handles exit; nothing else to do.
      return;
    }
    logger.error('Fatal error in scraper', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Route through the shutdown manager so partial progress is flushed.
    await requestShutdown('fatal-error', 1);
  }
}

main();
