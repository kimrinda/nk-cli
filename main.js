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
 *   node main.js --verify hanime
 *   node main.js --verify 2d-animation --method cli
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
import { verifyCategory, printVerifyReport } from './src/verify/verifyDetails.js';
import {
  loadMissingReport,
  buildReport,
  saveMissingReport,
  deleteMissingReport,
  reportsAreEqual,
} from './src/verify/missingReport.js';
import {
  bulkDownload,
  buildDetailJobs,
  buildHanimeIndexJobs,
  printDownloadReport,
  thumbnailDir,
} from './src/thumbnail/downloader.js';
import {
  verifyThumbnails,
  verifyHanimeIndexThumbnails,
  printThumbnailVerifyReport,
} from './src/thumbnail/thumbnailVerify.js';

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
    case 'verify':
    case 'thumbnail':
    case 'verifyThumbnail':
      throw new Error(
        'resolveProgressTarget should not be called for verify/thumbnail actions',
      );
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
/*  Verify action                                                     */
/* ------------------------------------------------------------------ */

/**
 * Lazily import `@inquirer/prompts.select`. Returns `null` when the
 * package is unavailable so callers can fall back to a safe default.
 *
 * @returns {Promise<((q: object) => Promise<string>) | null>} Loaded
 *   `select` function or `null`.
 */
async function loadSelect() {
  try {
    const mod = await import('@inquirer/prompts');
    return /** @type {any} */ (mod).select ?? null;
  } catch {
    return null;
  }
}

/**
 * Prompt the user to select a scraping method (CLI, Browser, or Cancel).
 *
 * Falls back to the value of `fallbackMethod` in non-interactive mode.
 *
 * @param {ScrapeMethod} fallbackMethod Default method when stdin is
 *   not a TTY or inquirer is unavailable.
 * @returns {Promise<ScrapeMethod | 'cancel'>} The chosen method or
 *   `'cancel'` if the user aborted.
 */
async function promptScrapeMethod(fallbackMethod) {
  const select = await loadSelect();
  if (!select || !process.stdin.isTTY) {
    logger.info('Non-interactive mode — using default scrape method', {
      method: fallbackMethod,
    });
    return fallbackMethod;
  }
  /** @type {string} */
  const choice = await select({
    message: 'Which scraping method would you like to use?',
    choices: [
      { name: 'CLI  (axios + cheerio — fast, needs fresh cookies)', value: 'cli' },
      { name: 'Browser  (puppeteer — slower, handles WAF automatically)', value: 'browser' },
      { name: 'Cancel', value: 'cancel' },
    ],
    default: fallbackMethod,
  });
  return /** @type {ScrapeMethod | 'cancel'} */ (choice);
}
/**
 * Scrape only the supplied missing items using the selected method,
 * inserting results into the existing per-prefix detail store. Reuses
 * the existing detail scraper pipelines with a synthetic listing
 * composed from the missing items.
 *
 * @param {ScrapeMethod} method Scraping engine chosen by the user.
 * @param {ReturnType<typeof getCategory>} category Resolved category.
 * @param {import('./src/verify/verifyDetails.js').MissingItem[]} items
 *   Missing items to scrape.
 * @returns {Promise<void>} Resolves once the scrape finishes.
 */
async function scrapeMissingItems(method, category, items) {
  if (!items.length) {
    logger.info('No missing items to scrape');
    return;
  }

  /** @type {ListingItem[]} */
  const syntheticList = items.map((m) => ({
    slug: m.slug,
    title: m.title,
    thumbnail: m.thumbnail ?? '',
    url: m.url,
  }));

  const detailTarget = {
    command: `scrape:${category.key}:detail`,
    outputFile: /** @type {string} */ (category.detailManifestPath),
  };

  const progress = new ProgressManager(detailTarget);
  await progress.init({
    totalItems: syntheticList.length,
    lastCompletedIndex: -1,
  });

  logger.info('Starting missing-item scrape', {
    category: category.key,
    method,
    itemCount: syntheticList.length,
  });

  if (method === 'cli') {
    const session = await createSession();
    await scrapeDetailsHttp(session, category, syntheticList, {
      progress,
      startIndex: 0,
    });
  } else {
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
      await scrapeDetails(browser, category, syntheticList, {
        progress,
        startIndex: 0,
      });
    } finally {
      await closeBrowser(browser);
      browser = null;
    }
  }

  logger.info('Missing-item scrape completed', {
    category: category.key,
    items: syntheticList.length,
  });
}

/**
 * Run a full `--verify` action: check detail completeness, prompt the
 * user for next steps, and optionally scrape missing items or save a
 * report file.
 *
 * @param {CliAction & { type: 'verify' }} action Parsed verify action.
 * @returns {Promise<void>} Resolves once the verify flow finishes.
 */
async function runVerify(action) {
  installShutdownHooks();
  const category = getCategory(action.categoryKey);
  logger.info('nk-cli verify starting', {
    category: category.key,
  });

  // Check for an existing missing report first.
  const existingReport = await loadMissingReport(action.categoryKey);

  if (existingReport && existingReport.missingItems > 0) {
    // A previous report exists — offer to scrape, re-check, or skip.
    logger.info('A previous missing-detail report was found', {
      category: action.categoryKey,
      missingItems: existingReport.missingItems,
    });

    const select = await loadSelect();
    /** @type {string} */
    let reportChoice = 'recheck';

    if (select && process.stdin.isTTY) {
      reportChoice = await select({
        message:
          `A previous missing-detail report was found ` +
          `(${existingReport.missingItems} missing item(s)). ` +
          'What would you like to do?',
        choices: [
          { name: 'Yes — scrape the missing items now', value: 'yes' },
          { name: 'No — exit without changes', value: 'no' },
          { name: 'Re-check / Verify Again', value: 'recheck' },
        ],
        default: 'yes',
      });
    }

    if (reportChoice === 'yes') {
      const method = await promptScrapeMethod(action.method);
      if (method === 'cancel') {
        logger.info('User cancelled method selection — exiting');
        return;
      }
      await scrapeMissingItems(method, category, existingReport.items);

      // Re-verify after scraping to see if any still remain.
      const freshResult = await verifyCategory(action.categoryKey);
      await printVerifyReport(freshResult);

      if (freshResult.missingItems === 0) {
        await deleteMissingReport(action.categoryKey);
      } else {
        const updated = buildReport(freshResult, existingReport);
        await saveMissingReport(action.categoryKey, updated);
      }
      return;
    }

    if (reportChoice === 'no') {
      // Compare current state with saved report before exiting.
      const freshResult = await verifyCategory(action.categoryKey);
      const freshReport = buildReport(freshResult, existingReport);

      if (!reportsAreEqual(existingReport, freshReport)) {
        logger.info('Report has changed since last save — updating on disk');
        await saveMissingReport(action.categoryKey, freshReport);
      } else {
        logger.info('Report unchanged — exiting safely');
      }
      return;
    }

    // reportChoice === 'recheck' — fall through to fresh verification.
  }

  // Fresh verification pass.
  const result = await verifyCategory(action.categoryKey);
  await printVerifyReport(result);

  if (result.missingItems === 0) {
    // Nothing is missing — clean up any stale report.
    await deleteMissingReport(action.categoryKey);
    logger.info('Verification complete — no missing items', {
      category: action.categoryKey,
    });
    return;
  }

  // Prompt user.
  const select = await loadSelect();
  /** @type {string} */
  let userChoice = 'no';

  if (select && process.stdin.isTTY) {
    userChoice = await select({
      message: `${result.missingItems} missing item(s) found. Do you want to scrape them?`,
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'No', value: 'no' },
      ],
      default: 'yes',
    });
  } else {
    logger.info(
      'Non-interactive mode — saving missing report without scraping',
    );
  }

  if (userChoice === 'yes') {
    const method = await promptScrapeMethod(action.method);
    if (method === 'cancel') {
      logger.info('User cancelled method selection — saving report instead');
      const report = buildReport(result, existingReport);
      const filePath = await saveMissingReport(action.categoryKey, report);
      logger.info('Missing items saved to report — scrape them later with --verify', {
        file: filePath,
      });
      return;
    }
    await scrapeMissingItems(method, category, result.items);

    // Re-verify after scraping.
    const freshResult = await verifyCategory(action.categoryKey);
    await printVerifyReport(freshResult);

    if (freshResult.missingItems === 0) {
      await deleteMissingReport(action.categoryKey);
    } else {
      const report = buildReport(freshResult, existingReport);
      await saveMissingReport(action.categoryKey, report);
    }
  } else {
    // Save missing report for later.
    const report = buildReport(result, existingReport);
    const filePath = await saveMissingReport(action.categoryKey, report);
    logger.info('Missing items saved to report — scrape them later with --verify', {
      file: filePath,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Thumbnail download action                                         */
/* ------------------------------------------------------------------ */

/**
 * Run a `--thumbnail <category>` download action.
 *
 * @param {CliAction & { type: 'thumbnail' }} action Parsed action.
 * @returns {Promise<void>} Resolves once the download finishes.
 */
async function runThumbnail(action) {
  installShutdownHooks();
  const categoryKey = action.categoryKey;
  const isIndex = categoryKey === 'hanimeindex';
  const label = isIndex ? 'Hanime Index (A–Z Covers)' : getCategory(categoryKey).label;

  logger.info('nk-cli thumbnail download starting', { category: categoryKey });

  const jobs = isIndex
    ? await buildHanimeIndexJobs()
    : await buildDetailJobs(categoryKey);

  if (jobs.length === 0) {
    logger.warn('No thumbnail jobs to process — are the detail/index files present?', {
      category: categoryKey,
    });
    return;
  }

  const result = await bulkDownload(jobs);
  await printDownloadReport(result, label);
}

/* ------------------------------------------------------------------ */
/*  Thumbnail verify action                                           */
/* ------------------------------------------------------------------ */

/**
 * Run a `--verify --thumbnail <category>` verification action.
 *
 * @param {CliAction & { type: 'verifyThumbnail' }} action Parsed action.
 * @returns {Promise<void>} Resolves once the verification finishes.
 */
async function runVerifyThumbnail(action) {
  installShutdownHooks();
  const categoryKey = action.categoryKey;
  const isIndex = categoryKey === 'hanimeindex';
  const label = isIndex ? 'Hanime Index (A\u2013Z Covers)' : getCategory(categoryKey).label;

  logger.info('nk-cli thumbnail verification starting', { category: categoryKey });

  const result = isIndex
    ? await verifyHanimeIndexThumbnails()
    : await verifyThumbnails(categoryKey);

  await printThumbnailVerifyReport(result);

  if (result.missingItems > 0) {
    // Offer to download the missing thumbnails.
    const select = await loadSelect();
    /** @type {string} */
    let userChoice = 'no';

    if (select && process.stdin.isTTY) {
      userChoice = await select({
        message: `${result.missingItems} thumbnail(s) missing. Download them now?`,
        choices: [
          { name: 'Yes', value: 'yes' },
          { name: 'No', value: 'no' },
        ],
        default: 'yes',
      });
    } else {
      logger.info('Non-interactive mode — skipping thumbnail download');
    }

    if (userChoice === 'yes') {
      const jobs = isIndex
        ? await buildHanimeIndexJobs()
        : await buildDetailJobs(categoryKey);

      if (jobs.length > 0) {
        const dlResult = await bulkDownload(jobs);
        await printDownloadReport(dlResult, label);
      }
    }
  }
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
  // Verify has its own flow, independent of scrape engines.
  if (action.type === 'verify') {
    await runVerify(/** @type {CliAction & { type: 'verify' }} */ (action));
    return;
  }

  // Thumbnail download.
  if (action.type === 'thumbnail') {
    await runThumbnail(/** @type {CliAction & { type: 'thumbnail' }} */ (action));
    return;
  }

  // Thumbnail verification.
  if (action.type === 'verifyThumbnail') {
    await runVerifyThumbnail(/** @type {CliAction & { type: 'verifyThumbnail' }} */ (action));
    return;
  }

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
