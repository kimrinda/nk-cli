/**
 * @file Core verification logic for detail content completeness.
 *
 * Compares the parent listing JSON (`<category>Lists.json`) against all
 * split detail bucket files inside `output/details/<category>/` and
 * produces a structured verification result that identifies every slug
 * present in the listing but absent from the detail store.
 *
 * The module is category-agnostic — it works for every category that
 * has a listing path and a detail directory configured in the
 * {@link ResolvedCategory} descriptor.
 */

import { getCategory, buildDetailUrl } from '../config/categories.js';
import { loadAllDetailsForCategory } from '../storage/detailStorage.js';
import { readJson } from '../utils/storage.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 * @typedef {import('../parsers/pageItems.js').ListingItem} ListingItem
 */

/**
 * Single missing-item descriptor emitted by the verification pass.
 *
 * @typedef {object} MissingItem
 * @property {string} slug Slug that exists in the list but not in any detail bucket.
 * @property {string} title Title from the listing entry (may be empty).
 * @property {string} url Absolute detail URL derived from the category config.
 * @property {string} thumbnail Thumbnail URL from the listing entry (may be empty).
 */

/**
 * Full verification result returned by {@link verifyCategory}.
 *
 * @typedef {object} VerifyResult
 * @property {string} category Category key.
 * @property {string} categoryLabel Human-readable label.
 * @property {string} listingPath Absolute path to the listing JSON.
 * @property {string} detailDir Absolute path to the detail directory.
 * @property {number} totalListItems Total items in the listing file.
 * @property {number} verifiedItems Items found in both list and detail store.
 * @property {number} missingItems Count of items in the list but not in details.
 * @property {number} missingPercent Missing as a percentage of the total.
 * @property {MissingItem[]} items The missing items.
 */

/**
 * Run the verification pass for a single category.
 *
 * Loads the parent listing JSON and every split detail bucket via
 * {@link loadAllDetailsForCategory}, then compares slugs. A slug
 * is considered verified when it appears in at least one bucket file;
 * missing otherwise.
 *
 * @param {string} categoryKey CLI key (e.g. `hanime`, `2d-animation`).
 * @returns {Promise<VerifyResult>} Structured verification result.
 * @throws {Error} When the category key is unknown, lacks a listing
 *   file, or lacks a detail directory.
 */
export async function verifyCategory(categoryKey) {
  const category = getCategory(categoryKey);

  if (!category.detailDir || !category.detailFilenamePrefix) {
    throw new Error(
      `Category "${categoryKey}" has no detail storage configured. ` +
        'Cannot verify.',
    );
  }

  /** @type {ListingItem[]} */
  const listItems = await readJson(category.listingPath, []);
  if (!listItems.length) {
    logger.warn('Listing file is empty or missing — nothing to verify', {
      category: categoryKey,
      file: category.listingPath,
    });
  }

  const detailRecords = await loadAllDetailsForCategory(category);
  /** @type {Set<string>} */
  const detailSlugs = new Set(
    detailRecords
      .filter((r) => r?.slug)
      .map((r) => r.slug),
  );

  /** @type {MissingItem[]} */
  const missing = [];

  for (const item of listItems) {
    if (!item?.slug) continue;
    if (!detailSlugs.has(item.slug)) {
      missing.push({
        slug: item.slug,
        title: item.title ?? '',
        url: buildDetailUrl(category, item),
        thumbnail: item.thumbnail ?? '',
      });
    }
  }

  const totalListItems = listItems.length;
  const missingItems = missing.length;
  const verifiedItems = totalListItems - missingItems;
  const missingPercent =
    totalListItems > 0
      ? Number(((missingItems / totalListItems) * 100).toFixed(2))
      : 0;

  return {
    category: categoryKey,
    categoryLabel: category.label,
    listingPath: category.listingPath,
    detailDir: category.detailDir,
    totalListItems,
    verifiedItems,
    missingItems,
    missingPercent,
    items: missing,
  };
}

/**
 * Print a coloured verification report to the terminal.
 *
 * Uses chalk (when available) to colour-code the statistics:
 *   - green for verified / healthy counts
 *   - red for missing items / percentages
 *   - cyan for informational labels
 *   - dim for paths
 *
 * @param {VerifyResult} result Verification result to display.
 * @returns {Promise<void>} Resolves once all lines are written.
 */
export async function printVerifyReport(result) {
  /** @type {import('chalk').ChalkInstance | null} */
  let chalk = null;
  try {
    const mod = await import('chalk');
    if (typeof mod.Chalk === 'function') {
      chalk = new mod.Chalk({ level: 1 });
    } else {
      chalk = mod.default;
    }
  } catch {
    // Colour-less fallback is fine.
  }

  const c = (/** @type {string} */ s) => s;
  const green = chalk ? (/** @type {string} */ s) => chalk.green(s) : c;
  const red = chalk ? (/** @type {string} */ s) => chalk.red.bold(s) : c;
  const cyan = chalk ? (/** @type {string} */ s) => chalk.cyan(s) : c;
  const dim = chalk ? (/** @type {string} */ s) => chalk.dim(s) : c;
  const bold = chalk ? (/** @type {string} */ s) => chalk.bold(s) : c;
  const yellow = chalk ? (/** @type {string} */ s) => chalk.yellow(s) : c;
  const magenta = chalk ? (/** @type {string} */ s) => chalk.magenta(s) : c;

  const divider = dim('─'.repeat(60));
  const w = process.stdout.write.bind(process.stdout);

  w('\n');
  w(`${divider}\n`);
  w(`  ${bold(cyan('DETAIL VERIFICATION REPORT'))}\n`);
  w(`${divider}\n`);
  w(`  ${cyan('Category')}         ${bold(result.categoryLabel)} ${dim(`(${result.category})`)}\n`);
  w(`  ${cyan('Listing file')}     ${dim(result.listingPath)}\n`);
  w(`  ${cyan('Detail folder')}    ${dim(result.detailDir)}\n`);
  w(`${divider}\n`);
  w(`  ${cyan('Total list items')}   ${bold(String(result.totalListItems))}\n`);
  w(`  ${cyan('Verified items')}     ${green(String(result.verifiedItems))}\n`);

  if (result.missingItems > 0) {
    w(`  ${cyan('Missing items')}      ${red(String(result.missingItems))}\n`);
    w(`  ${cyan('Missing %')}          ${red(`${result.missingPercent}%`)}\n`);
  } else {
    w(`  ${cyan('Missing items')}      ${green('0')}\n`);
    w(`  ${cyan('Missing %')}          ${green('0%')}\n`);
  }

  w(`${divider}\n`);

  if (result.missingItems === 0) {
    w(`  ${green('✔')} ${bold('All list items have been scraped!')}\n`);
  } else {
    w(`  ${yellow('⚠')} ${bold(`${result.missingItems} item(s) are missing detail content.`)}\n`);

    const previewCount = Math.min(result.items.length, 10);
    if (previewCount > 0) {
      w(`\n  ${magenta('First missing items:')}\n`);
      for (let i = 0; i < previewCount; i += 1) {
        const m = result.items[i];
        const label = m.title || m.slug;
        w(`    ${dim(`${i + 1}.`)} ${label} ${dim(`(${m.slug})`)}\n`);
      }
      if (result.items.length > previewCount) {
        w(`    ${dim(`… and ${result.items.length - previewCount} more`)}\n`);
      }
    }
  }

  w(`${divider}\n\n`);
}
