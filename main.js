#!/usr/bin/env node
/**
 * @file Entry point for the nk-cli scraper.
 *
 * Dispatches the user-supplied CLI action to the matching scraper
 * pipeline (browser or HTTP) and installs graceful shutdown hooks.
 *
 * Usage:
 *   node main.js --scrape hanime --method cli
 *   node main.js --scrape hanime --method browser
 *   node main.js --scrape hanimeinfo --slug my-slug --method cli
 *   node main.js --scrape hanimeindex --method browser
 *   node main.js --scrape info --category hanime --page hanime --method cli
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
import { scrapeListingHttp } from './src/http/listingScraper.js';
import { scrapeDetailsHttp } from './src/http/detailScraper.js';
import { scrapeAzIndexHttp } from './src/http/azScraper.js';
import { createSession } from './src/http/session.js';
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
 * @typedef {import('./src/cli/parser.js').ScrapeMethod} ScrapeMethod
 * @typedef {import('./src/parsers/pageItems.js').ListingItem} ListingItem
 * @typedef {import('./src/http/session.js').HttpSession} HttpSession
 */

/**
 * Resolve the canonical (command, output file) pair for a CLI action.
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
      if (!category.detailManifestPath) {
        throw new Error(
          `Category "${category.key}" has no detail output configured`,
        );
      }
      return {
        command: `scrape:${category.key}:detail`,
        outputFile: category.detailManifestPath,
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

/* ------------------------------------------------------------------ */
/*  Browser-mode action runners                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a `listing` action via Puppeteer.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves when the action is fully done.
 */
async function runListingActionBrowser(browser, category, resume) {
  const items = await scrapeListing(browser, category, {
    progress: resume.progress,
    startPage: resume.startIndex + 1,
  });
  logger.info('Listing phase finished (browser)', {
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

  const detailResume = await negotiateAndPrepareProgress(
    { type: 'detailByPage', categoryKey: category.key, method: 'browser' },
    category,
  );
  await scrapeDetails(browser, category, items, {
    progress: detailResume.progress,
    startIndex: detailResume.startIndex,
  });
}

/**
 * Run an `azIndex` action via Puppeteer.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves once the index has been written.
 */
async function runAzActionBrowser(browser, category, resume) {
  const result = await scrapeAzIndex(browser, category, {
    progress: resume.progress,
  });
  logger.info('AZ index phase finished (browser)', {
    category: category.key,
    groups: result.totalGroups,
    items: result.totalItems,
    file: category.listingPath,
  });
}

/**
 * Run a `detailByPage` action via Puppeteer.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves when the detail phase finishes.
 */
async function runDetailByPageActionBrowser(browser, category, resume) {
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
 * Run a `detailBySlug` action via Puppeteer.
 *
 * @param {import('puppeteer').Browser} browser Active Puppeteer browser.
 * @param {ReturnType<typeof getCategory>} category Resolved category context.
 * @param {string} slug Slug to scrape.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves once the detail has been written.
 */
async function runDetailBySlugActionBrowser(browser, category, slug, resume) {
  const items = [{ slug, title: '', thumbnail: '', url: '' }];
  const records = await scrapeDetails(browser, category, items, {
    progress: resume.progress,
    startIndex: resume.startIndex,
  });
  const record = records.find((entry) => entry.slug === slug);
  if (!record) {
    throw new Error(`scrapeSingleDetail: no record produced for ${slug}`);
  }
  logger.info('Single detail scrape finished (browser)', {
    slug: record.slug,
    url: record.url,
    manifest: category.detailManifestPath,
  });
}

/* ------------------------------------------------------------------ */
/*  HTTP-mode action runners                                          */
/* ------------------------------------------------------------------ */

/**
 * Run a `listing` action over HTTP (axios + cheerio).
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves when the action is fully done.
 */
async function runListingActionHttp(session, category, resume) {
  const items = await scrapeListingHttp(session, category, {
    progress: resume.progress,
    startPage: resume.startIndex + 1,
  });
  logger.info('Listing phase finished (cli)', {
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

  const detailResume = await negotiateAndPrepareProgress(
    { type: 'detailByPage', categoryKey: category.key, method: 'cli' },
    category,
  );
  await scrapeDetailsHttp(session, category, items, {
    progress: detailResume.progress,
    startIndex: detailResume.startIndex,
  });
}

/**
 * Run an `azIndex` action over HTTP.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves once the index has been written.
 */
async function runAzActionHttp(session, category, resume) {
  const result = await scrapeAzIndexHttp(session, category, {
    progress: resume.progress,
  });
  logger.info('AZ index phase finished (cli)', {
    category: category.key,
    groups: result.totalGroups,
    items: result.totalItems,
    file: category.listingPath,
  });
}

/**
 * Run a `detailByPage` action over HTTP.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves when the detail phase finishes.
 */
async function runDetailByPageActionHttp(session, category, resume) {
  /** @type {ListingItem[]} */
  const items = await readJson(category.listingPath, []);
  logger.info('Loaded listing from disk', {
    category: category.key,
    count: items.length,
    file: category.listingPath,
  });
  if (!items.length) {
    logger.warn(
      'No listing entries found on disk — run the listing scrape first ' +
        '(e.g. --scrape <key> --method cli).',
      { category: category.key, file: category.listingPath },
    );
    return;
  }
  await scrapeDetailsHttp(session, category, items, {
    progress: resume.progress,
    startIndex: resume.startIndex,
  });
}

/**
 * Run a `detailBySlug` action over HTTP.
 *
 * @param {HttpSession} session Initialised HTTP session.
 * @param {ReturnType<typeof getCategory>} category Resolved category context.
 * @param {string} slug Slug to scrape.
 * @param {{ progress: ProgressManager, startIndex: number }} resume Resume state.
 * @returns {Promise<void>} Resolves once the detail has been written.
 */
async function runDetailBySlugActionHttp(session, category, slug, resume) {
  const items = [{ slug, title: '', thumbnail: '', url: '' }];
  const records = await scrapeDetailsHttp(session, category, items, {
    progress: resume.progress,
    startIndex: resume.startIndex,
  });
  const record = records.find((entry) => entry.slug === slug);
  if (!record) {
    throw new Error(`scrapeSingleDetailHttp: no record produced for ${slug}`);
  }
  logger.info('Single detail scrape finished (cli)', {
    slug: record.slug,
    url: record.url,
    manifest: category.detailManifestPath,
  });
}

/* ------------------------------------------------------------------ */
/*  Top-level dispatch                                                */
/* ------------------------------------------------------------------ */

/**
 * Dispatch the resolved CLI action against either the browser or the
 * HTTP scraping engine.
 *
 * @param {CliAction} action Parsed CLI intent.
 * @returns {Promise<void>} Resolves once the action is done.
 */
async function dispatch(action) {
  installShutdownHooks();
  const category = getCategory(action.categoryKey);
  logger.info('nk-cli scraper starting', {
    action: action.type,
    method: action.method,
    category: category.key,
    baseUrl: config.baseUrl,
  });

  // Negotiate resume *before* spinning up engines so a "Cancel" answer
  // doesn't leak a Chromium process or HTTP session.
  const resume = await negotiateAndPrepareProgress(action, category);
  if (isShutdownInProgress()) return;

  if (action.method === 'cli') {
    const session = await createSession();
    onShutdownAsync(async () => {
      // Nothing to close on the HTTP session itself; placeholder for
      // future cleanup (cookie persistence is already on disk).
    });
    switch (action.type) {
      case 'listing':
        await runListingActionHttp(session, category, resume);
        break;
      case 'azIndex':
        await runAzActionHttp(session, category, resume);
        break;
      case 'detailByPage':
        await runDetailByPageActionHttp(session, category, resume);
        break;
      case 'detailBySlug':
        await runDetailBySlugActionHttp(session, category, action.slug, resume);
        break;
      default: {
        /** @type {never} */
        const exhaustive = action;
        throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
    logger.info('nk-cli scraper finished', {
      action: action.type,
      method: action.method,
    });
    return;
  }

  // Browser mode (default).
  /** @type {import('puppeteer').Browser | null} */
  let browser = null;
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
        await runListingActionBrowser(browser, category, resume);
        break;
      case 'azIndex':
        await runAzActionBrowser(browser, category, resume);
        break;
      case 'detailByPage':
        await runDetailByPageActionBrowser(browser, category, resume);
        break;
      case 'detailBySlug':
        await runDetailBySlugActionBrowser(browser, category, action.slug, resume);
        break;
      default: {
        /** @type {never} */
        const exhaustive = action;
        throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }

    logger.info('nk-cli scraper finished', {
      action: action.type,
      method: action.method,
    });
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
      return;
    }
    logger.error('Fatal error in scraper', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await requestShutdown('fatal-error', 1);
  }
}

main();
