/**
 * @file Thumbnail / cover image verification.
 *
 * Checks whether each slug from the detail store (or hanimeindex) has a
 * matching image file in the target thumbnail directory. Produces a
 * structured report analogous to the detail verification system.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getCategory } from '../config/categories.js';
import { config } from '../config/index.js';
import { loadAllDetailsForCategory } from '../storage/detailStorage.js';
import { readJson } from '../utils/storage.js';
import { logger } from '../utils/logger.js';
import { thumbnailDir } from './downloader.js';

/**
 * Full thumbnail verification result.
 *
 * @typedef {object} ThumbnailVerifyResult
 * @property {string} category Category key.
 * @property {string} categoryLabel Human-readable label.
 * @property {string} thumbDir Absolute path to the thumbnail folder.
 * @property {number} totalItems Total slugs with an image URL.
 * @property {number} verifiedItems Slugs with a matching file on disk.
 * @property {number} missingItems Slugs without a file.
 * @property {number} missingPercent Missing as a percentage.
 * @property {string[]} missingSlugs The missing slug identifiers.
 */

/**
 * Build a set of filenames (without extension) present in a directory.
 *
 * @param {string} dir Absolute directory path.
 * @returns {Set<string>} Basenames (no ext) of every file in `dir`.
 */
function readFileSlugs(dir) {
  /** @type {Set<string>} */
  const slugs = new Set();
  try {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      slugs.add(path.parse(e).name);
    }
  } catch {
    // Directory doesn't exist yet — empty set.
  }
  return slugs;
}

/**
 * Verify thumbnail completeness for a normal detail category.
 *
 * @param {string} categoryKey CLI category key (not `hanimeindex`).
 * @returns {Promise<ThumbnailVerifyResult>} Structured result.
 */
export async function verifyThumbnails(categoryKey) {
  const category = getCategory(categoryKey);
  const records = await loadAllDetailsForCategory(category);
  const dir = thumbnailDir(categoryKey);
  const existing = readFileSlugs(dir);

  /** @type {string[]} */
  const missingSlugs = [];
  let totalWithUrl = 0;

  for (const item of records) {
    const imageUrl =
      item.images?.largest ||
      item.images?.src ||
      item.listing?.thumbnail;
    if (!imageUrl) continue;
    totalWithUrl += 1;
    if (!existing.has(item.slug)) {
      missingSlugs.push(item.slug);
    }
  }

  const missingItems = missingSlugs.length;
  const verifiedItems = totalWithUrl - missingItems;
  const missingPercent =
    totalWithUrl > 0
      ? Number(((missingItems / totalWithUrl) * 100).toFixed(2))
      : 0;

  return {
    category: categoryKey,
    categoryLabel: category.label,
    thumbDir: dir,
    totalItems: totalWithUrl,
    verifiedItems,
    missingItems,
    missingPercent,
    missingSlugs,
  };
}

/**
 * Verify thumbnail completeness for the `hanimeindex` covers.
 *
 * @returns {Promise<ThumbnailVerifyResult>} Structured result.
 */
export async function verifyHanimeIndexThumbnails() {
  const indexPath = path.join(config.paths.output, 'hanimeIndex.json');
  const data = await readJson(indexPath, null);
  const dir = thumbnailDir('hanimeindex');
  const existing = readFileSlugs(dir);

  /** @type {string[]} */
  const missingSlugs = [];
  let totalWithUrl = 0;

  if (data?.groups) {
    for (const groupKey of Object.keys(data.groups)) {
      const group = data.groups[groupKey];
      const items = group?.items ?? group;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item?.tooltip?.image || !item?.slug) continue;
        totalWithUrl += 1;
        if (!existing.has(item.slug)) {
          missingSlugs.push(item.slug);
        }
      }
    }
  }

  const missingItems = missingSlugs.length;
  const verifiedItems = totalWithUrl - missingItems;
  const missingPercent =
    totalWithUrl > 0
      ? Number(((missingItems / totalWithUrl) * 100).toFixed(2))
      : 0;

  return {
    category: 'hanimeindex',
    categoryLabel: 'Hanime Index (A–Z Covers)',
    thumbDir: dir,
    totalItems: totalWithUrl,
    verifiedItems,
    missingItems,
    missingPercent,
    missingSlugs,
  };
}

/**
 * Print a coloured thumbnail verification report to the terminal.
 *
 * @param {ThumbnailVerifyResult} result Verification result.
 * @returns {Promise<void>} Resolves once all lines are written.
 */
export async function printThumbnailVerifyReport(result) {
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
  w(`  ${bold(cyan('THUMBNAIL VERIFICATION REPORT'))}\n`);
  w(`${divider}\n`);
  w(`  ${cyan('Category')}         ${bold(result.categoryLabel)} ${dim(`(${result.category})`)}\n`);
  w(`  ${cyan('Thumbnail folder')} ${dim(result.thumbDir)}\n`);
  w(`${divider}\n`);
  w(`  ${cyan('Total items')}        ${bold(String(result.totalItems))}\n`);
  w(`  ${cyan('Verified (exist)')}   ${green(String(result.verifiedItems))}\n`);

  if (result.missingItems > 0) {
    w(`  ${cyan('Missing')}            ${red(String(result.missingItems))}\n`);
    w(`  ${cyan('Missing %')}          ${red(`${result.missingPercent}%`)}\n`);
  } else {
    w(`  ${cyan('Missing')}            ${green('0')}\n`);
    w(`  ${cyan('Missing %')}          ${green('0%')}\n`);
  }

  w(`${divider}\n`);

  if (result.missingItems === 0) {
    w(`  ${green('✔')} ${bold('All thumbnails are present!')}\n`);
  } else {
    w(`  ${yellow('⚠')} ${bold(`${result.missingItems} thumbnail(s) are missing.`)}\n`);
    const previewCount = Math.min(result.missingSlugs.length, 10);
    if (previewCount > 0) {
      w(`\n`);
      for (let i = 0; i < previewCount; i += 1) {
        w(`    ${dim(`${i + 1}.`)} ${result.missingSlugs[i]}\n`);
      }
      if (result.missingSlugs.length > previewCount) {
        w(`    ${dim(`… and ${result.missingSlugs.length - previewCount} more`)}\n`);
      }
    }
  }

  w(`${divider}\n\n`);
}
