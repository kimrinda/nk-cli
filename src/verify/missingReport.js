/**
 * @file Missing-detail report persistence and loading.
 *
 * Manages the `missing-detail-report.json` file that records which slugs
 * from the parent listing are absent from the split detail store. The
 * report includes enough metadata to re-scrape the missing items later
 * without a full re-verification pass.
 *
 * File location:
 *   `output/details/<category>/missing-detail-report.json`
 */

import path from 'node:path';

import { getCategory } from '../config/categories.js';
import { readJson, writeJson } from '../utils/storage.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {import('./verifyDetails.js').VerifyResult} VerifyResult
 * @typedef {import('./verifyDetails.js').MissingItem} MissingItem
 */

/**
 * Serialised missing-detail report persisted to disk.
 *
 * @typedef {object} MissingDetailReport
 * @property {string} category Category key.
 * @property {number} totalListItems Total items in the parent listing.
 * @property {number} verifiedItems Items confirmed present in detail store.
 * @property {number} missingItems Count of missing slugs.
 * @property {MissingItem[]} items The missing items with URL / title.
 * @property {string} createdAt ISO 8601 creation timestamp.
 * @property {string} updatedAt ISO 8601 last-update timestamp.
 */

/**
 * Canonical filename for the missing-detail report within a detail dir.
 *
 * @type {string}
 */
export const MISSING_REPORT_FILENAME = 'missing-detail-report.json';

/**
 * Resolve the absolute path to the missing-detail report for a category.
 *
 * @param {string} categoryKey CLI key (e.g. `hanime`).
 * @returns {string} Absolute path.
 * @throws {Error} When the category has no detail directory configured.
 */
export function missingReportPath(categoryKey) {
  const category = getCategory(categoryKey);
  if (!category.detailDir) {
    throw new Error(
      `Category "${categoryKey}" has no detail directory configured.`,
    );
  }
  return path.join(category.detailDir, MISSING_REPORT_FILENAME);
}

/**
 * Load an existing missing-detail report from disk, if it exists.
 *
 * @param {string} categoryKey CLI key.
 * @returns {Promise<MissingDetailReport | null>} Loaded report or `null`.
 */
export async function loadMissingReport(categoryKey) {
  const filePath = missingReportPath(categoryKey);
  /** @type {MissingDetailReport | null} */
  const report = await readJson(filePath, /** @type {any} */ (null));
  if (
    report &&
    typeof report === 'object' &&
    Array.isArray(report.items) &&
    report.category === categoryKey
  ) {
    logger.info('Loaded existing missing-detail report', {
      category: categoryKey,
      missingItems: report.missingItems,
      updatedAt: report.updatedAt,
      file: filePath,
    });
    return report;
  }
  return null;
}

/**
 * Build a {@link MissingDetailReport} from a verification result.
 *
 * @param {VerifyResult} result Fresh verification result.
 * @param {MissingDetailReport | null} [previous] Optional previous
 *   report whose `createdAt` should be preserved.
 * @returns {MissingDetailReport} Report ready for persistence.
 */
export function buildReport(result, previous) {
  const now = new Date().toISOString();
  return {
    category: result.category,
    totalListItems: result.totalListItems,
    verifiedItems: result.verifiedItems,
    missingItems: result.missingItems,
    items: result.items,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Persist a missing-detail report to disk, atomically.
 *
 * @param {string} categoryKey CLI key.
 * @param {MissingDetailReport} report Report data to write.
 * @returns {Promise<string>} Absolute path of the written file.
 */
export async function saveMissingReport(categoryKey, report) {
  const filePath = missingReportPath(categoryKey);
  await writeJson(filePath, report);
  logger.info('Missing-detail report saved', {
    category: categoryKey,
    missingItems: report.missingItems,
    file: filePath,
  });
  return filePath;
}

/**
 * Delete the missing-detail report for a category, if it exists.
 * Used after all missing items have been successfully scraped.
 *
 * @param {string} categoryKey CLI key.
 * @returns {Promise<void>} Resolves once the file is removed.
 */
export async function deleteMissingReport(categoryKey) {
  const fsp = await import('node:fs/promises');
  const filePath = missingReportPath(categoryKey);
  try {
    await fsp.unlink(filePath);
    logger.info('Missing-detail report deleted (all items scraped)', {
      category: categoryKey,
      file: filePath,
    });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'ENOENT') {
      logger.warn('Failed to delete missing-detail report', {
        category: categoryKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Compare two reports and determine whether they are logically identical
 * (same set of missing slugs in the same order).
 *
 * @param {MissingDetailReport} a First report.
 * @param {MissingDetailReport} b Second report.
 * @returns {boolean} True when both reports contain the same missing slugs.
 */
export function reportsAreEqual(a, b) {
  if (a.missingItems !== b.missingItems) return false;
  if (a.totalListItems !== b.totalListItems) return false;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    if (a.items[i].slug !== b.items[i].slug) return false;
  }
  return true;
}
