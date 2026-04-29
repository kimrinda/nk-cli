/**
 * @file Concurrent thumbnail / cover image downloader.
 *
 * Downloads images in configurable parallel batches with a progress
 * bar, retry logic, and WAF-friendly request headers. Works for both
 * normal detail categories and the `hanimeindex` A-Z cover images.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { buildDefaultHeaders } from '../http/client.js';
import { readCookies } from '../http/cookieStore.js';
import { getCookieFilePath } from '../http/cookieStore.js';
import { loadAllDetailsForCategory } from '../storage/detailStorage.js';
import { getCategory } from '../config/categories.js';
import { readJson } from '../utils/storage.js';

/**
 * @typedef {import('../services/detailScraper.js').DetailRecord} DetailRecord
 */

/**
 * Descriptor for a single image download job.
 *
 * @typedef {object} DownloadJob
 * @property {string} slug Identifier (used for the filename).
 * @property {string} url Absolute URL to download.
 * @property {string} destDir Absolute directory to save into.
 */

/**
 * Aggregated result for a batch download run.
 *
 * @typedef {object} DownloadResult
 * @property {number} total Total jobs queued.
 * @property {number} downloaded Successfully downloaded.
 * @property {number} skipped Already existed on disk.
 * @property {number} failed Failed after retries.
 * @property {string[]} failedSlugs Slugs that failed.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract the file extension from a URL, falling back to `.jpg`.
 *
 * @param {string} url Image URL.
 * @returns {string} Extension including the leading dot.
 */
function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'].includes(ext)
      ? ext
      : '.jpg';
  } catch {
    return '.jpg';
  }
}

/**
 * Check whether a file matching `<slug>.*` already exists in `dir`.
 *
 * @param {string} dir Target directory.
 * @param {string} slug Slug to match.
 * @returns {boolean} True when a matching file is found.
 */
export function thumbnailExists(dir, slug) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.some((e) => {
      const base = path.parse(e).name;
      return base === slug;
    });
  } catch {
    return false;
  }
}

/**
 * Build a simple text-based progress bar string.
 *
 * @param {number} current Items processed so far.
 * @param {number} total Total items.
 * @param {number} [width] Bar width in characters.
 * @returns {string} Formatted progress line.
 */
function progressBar(current, total, width = 30) {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(width * pct);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${(pct * 100).toFixed(1)}% (${current}/${total})`;
}

/* ------------------------------------------------------------------ */
/*  Core downloader                                                   */
/* ------------------------------------------------------------------ */

/**
 * Download a single image to disk. Uses axios with the project's
 * standard browser-like headers and cookie authentication.
 *
 * @param {DownloadJob} job Download job descriptor.
 * @param {import('axios').AxiosInstance} client Configured axios client.
 * @returns {Promise<string>} Absolute path of the saved file.
 */
async function downloadOne(job, client) {
  const ext = extFromUrl(job.url);
  const filename = `${job.slug}${ext}`;
  const dest = path.join(job.destDir, filename);

  const response = await client.get(job.url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} for ${job.url}`);
  }

  await fsp.mkdir(job.destDir, { recursive: true });
  await fsp.writeFile(dest, Buffer.from(response.data));
  return dest;
}

/**
 * Run a batch of download jobs with bounded concurrency, retry, and
 * a live progress indicator.
 *
 * @param {DownloadJob[]} jobs All download jobs.
 * @param {object} [options] Configuration.
 * @param {number} [options.concurrency] Max parallel downloads.
 * @param {number} [options.retryAttempts] Per-job retry budget.
 * @param {number} [options.retryBaseDelayMs] Base delay for exp backoff.
 * @returns {Promise<DownloadResult>} Aggregated result.
 */
export async function bulkDownload(jobs, options = {}) {
  const concurrency = options.concurrency ?? config.scrape.thumbnailConcurrency;
  const retryAttempts = options.retryAttempts ?? config.scrape.retryAttempts;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? config.scrape.retryBaseDelayMs;

  // Build axios client with cookies for WAF compat.
  const cookies = await readCookies(getCookieFilePath());
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const client = axios.create({
    timeout: 30_000,
    headers: {
      ...buildDefaultHeaders(cookieHeader),
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
    },
    validateStatus: () => true,
    maxRedirects: 5,
    decompress: true,
  });

  /** @type {DownloadResult} */
  const result = {
    total: jobs.length,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    failedSlugs: [],
  };

  // Filter out already-downloaded files.
  /** @type {DownloadJob[]} */
  const pending = [];
  for (const job of jobs) {
    if (thumbnailExists(job.destDir, job.slug)) {
      result.skipped += 1;
    } else {
      pending.push(job);
    }
  }

  if (result.skipped > 0) {
    logger.info('Thumbnails already on disk — skipped', {
      skipped: result.skipped,
    });
  }

  if (pending.length === 0) {
    logger.info('All thumbnails are already downloaded');
    return result;
  }

  const totalToDownload = pending.length;
  let processed = 0;

  logger.info('Starting thumbnail download', {
    pending: totalToDownload,
    concurrency,
    retryAttempts,
  });

  // Process in concurrent batches.
  for (let i = 0; i < totalToDownload; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      batch.map((job) =>
        withRetry(() => downloadOne(job, client), {
          attempts: retryAttempts,
          baseDelayMs: retryBaseDelayMs,
          label: `download(${job.slug})`,
        }),
      ),
    );

    for (let j = 0; j < settled.length; j += 1) {
      processed += 1;
      if (settled[j].status === 'fulfilled') {
        result.downloaded += 1;
      } else {
        result.failed += 1;
        result.failedSlugs.push(batch[j].slug);
        const reason =
          settled[j].status === 'rejected'
            ? /** @type {PromiseRejectedResult} */ (settled[j]).reason
            : 'unknown';
        logger.warn('Thumbnail download failed', {
          slug: batch[j].slug,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }

    // Progress output.
    const bar = progressBar(processed, totalToDownload);
    const remaining = totalToDownload - processed;
    process.stdout.write(
      `\r  ${bar}  ✔ ${result.downloaded}  ✘ ${result.failed}  remaining: ${remaining}  `,
    );
  }

  // Final newline after progress bar.
  process.stdout.write('\n');
  return result;
}

/* ------------------------------------------------------------------ */
/*  Job builders                                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolve the thumbnail output directory for a category.
 *
 * @param {string} categoryKey CLI category key.
 * @returns {string} Absolute path to the thumbnails folder.
 */
export function thumbnailDir(categoryKey) {
  if (categoryKey === 'hanimeindex') {
    return path.join(config.paths.output, 'details', 'hanime-cover');
  }
  const category = getCategory(categoryKey);
  return path.join(/** @type {string} */ (category.detailDir), 'thumbnails');
}

/**
 * Build download jobs for a normal detail category (not hanimeindex).
 *
 * Uses the priority chain:
 *   1. `item.images.largest`
 *   2. `item.images.src`
 *   3. `item.listing.thumbnail`
 *
 * @param {string} categoryKey CLI category key.
 * @returns {Promise<DownloadJob[]>} Ready-to-execute download jobs.
 */
export async function buildDetailJobs(categoryKey) {
  const category = getCategory(categoryKey);
  const records = await loadAllDetailsForCategory(category);

  if (records.length === 0) {
    logger.warn('No detail records found — cannot build thumbnail jobs', {
      category: categoryKey,
    });
    return [];
  }

  const dest = thumbnailDir(categoryKey);
  /** @type {DownloadJob[]} */
  const jobs = [];

  for (const item of records) {
    const imageUrl =
      item.images?.largest ||
      item.images?.src ||
      item.listing?.thumbnail;
    if (!imageUrl) continue;
    jobs.push({ slug: item.slug, url: imageUrl, destDir: dest });
  }

  logger.info('Thumbnail jobs built from detail records', {
    category: categoryKey,
    total: jobs.length,
    detailRecords: records.length,
  });
  return jobs;
}

/**
 * Build download jobs for the `hanimeindex` A–Z cover images.
 *
 * Reads `output/hanimeIndex.json` and extracts `item.tooltip.image`.
 *
 * @returns {Promise<DownloadJob[]>} Ready-to-execute download jobs.
 */
export async function buildHanimeIndexJobs() {
  const indexPath = path.join(config.paths.output, 'hanimeIndex.json');
  const data = await readJson(indexPath, null);

  if (!data || !data.groups) {
    logger.warn('hanimeIndex.json not found or empty — cannot build jobs', {
      file: indexPath,
    });
    return [];
  }

  const dest = thumbnailDir('hanimeindex');
  /** @type {DownloadJob[]} */
  const jobs = [];

  for (const groupKey of Object.keys(data.groups)) {
    const group = data.groups[groupKey];
    const items = group?.items ?? group;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const imageUrl = item?.tooltip?.image;
      if (!imageUrl || !item?.slug) continue;
      jobs.push({ slug: item.slug, url: imageUrl, destDir: dest });
    }
  }

  logger.info('Thumbnail jobs built from hanimeIndex', {
    total: jobs.length,
    file: indexPath,
  });
  return jobs;
}

/**
 * Print a coloured summary of a download result.
 *
 * @param {DownloadResult} result Download result.
 * @param {string} label Human-readable category label.
 * @returns {Promise<void>} Resolves once all lines are written.
 */
export async function printDownloadReport(result, label) {
  /** @type {import('chalk').ChalkInstance | null} */
  let chalk = null;
  try {
    const mod = await import('chalk');
    chalk = typeof mod.Chalk === 'function' ? new mod.Chalk({ level: 1 }) : mod.default;
  } catch {
    // colour-less fallback.
  }

  const c = (/** @type {string} */ s) => s;
  const green = chalk ? (/** @type {string} */ s) => chalk.green(s) : c;
  const red = chalk ? (/** @type {string} */ s) => chalk.red.bold(s) : c;
  const cyan = chalk ? (/** @type {string} */ s) => chalk.cyan(s) : c;
  const dim = chalk ? (/** @type {string} */ s) => chalk.dim(s) : c;
  const bold = chalk ? (/** @type {string} */ s) => chalk.bold(s) : c;
  const yellow = chalk ? (/** @type {string} */ s) => chalk.yellow(s) : c;

  const divider = dim('─'.repeat(60));
  const w = process.stdout.write.bind(process.stdout);

  w('\n');
  w(`${divider}\n`);
  w(`  ${bold(cyan('THUMBNAIL DOWNLOAD REPORT'))}\n`);
  w(`${divider}\n`);
  w(`  ${cyan('Category')}         ${bold(label)}\n`);
  w(`  ${cyan('Total items')}      ${bold(String(result.total))}\n`);
  w(`  ${cyan('Downloaded')}       ${green(String(result.downloaded))}\n`);
  w(`  ${cyan('Skipped')}          ${dim(String(result.skipped))} ${dim('(already on disk)')}\n`);

  if (result.failed > 0) {
    w(`  ${cyan('Failed')}           ${red(String(result.failed))}\n`);
  } else {
    w(`  ${cyan('Failed')}           ${green('0')}\n`);
  }

  w(`${divider}\n`);

  if (result.failed === 0) {
    w(`  ${green('✔')} ${bold('All thumbnails are downloaded!')}\n`);
  } else {
    w(`  ${yellow('⚠')} ${bold(`${result.failed} thumbnail(s) failed to download.`)}\n`);
    const previewCount = Math.min(result.failedSlugs.length, 10);
    if (previewCount > 0) {
      for (let i = 0; i < previewCount; i += 1) {
        w(`    ${dim(`${i + 1}.`)} ${result.failedSlugs[i]}\n`);
      }
      if (result.failedSlugs.length > previewCount) {
        w(`    ${dim(`… and ${result.failedSlugs.length - previewCount} more`)}\n`);
      }
    }
  }

  w(`${divider}\n\n`);
}
