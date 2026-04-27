/**
 * @file Thin wrapper around `@inquirer/prompts` with a non-interactive
 * fallback so tests / CI / piped runs never hang.
 *
 * Resolution order for `confirmDetailScrape()`:
 *   1. `NK_AUTO_DETAIL=yes` / `=no` → return the matching boolean.
 *   2. `process.stdin.isTTY === false` → return `false` (don't block).
 *   3. Otherwise prompt the user via `@inquirer/prompts`'s `confirm`.
 *
 * `@inquirer/prompts` is loaded via dynamic import so the rest of the
 * CLI stays usable even if the dep is missing on a minimal install.
 */

import { logger } from '../utils/logger.js';

/**
 * Resolve the auto-detail env override into a tri-state.
 *
 * @returns {true|false|null} `true`/`false` for explicit values, `null` when unset.
 */
function readAutoDetailEnv() {
  const raw = (process.env.NK_AUTO_DETAIL ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

/**
 * Ask the user whether to continue with the detail-page scrape phase.
 *
 * @param {object} [options]
 * @param {string} [options.label] Human-readable category label rendered in the prompt.
 * @param {number} [options.itemCount] Number of listing items to be processed (for the prompt suffix).
 * @returns {Promise<boolean>} True when the detail phase should run.
 */
export async function confirmDetailScrape(options = {}) {
  const { label = 'this category', itemCount } = options;

  const fromEnv = readAutoDetailEnv();
  if (fromEnv !== null) {
    logger.info('Detail prompt resolved by env override', {
      NK_AUTO_DETAIL: process.env.NK_AUTO_DETAIL,
      decision: fromEnv,
    });
    return fromEnv;
  }

  if (!process.stdin.isTTY) {
    logger.info(
      'Detail prompt skipped (non-interactive stdin); assuming "No". ' +
        'Set NK_AUTO_DETAIL=yes to override.',
    );
    return false;
  }

  /** @type {((q: { message: string, default: boolean }) => Promise<boolean>) | null} */
  let confirm = null;
  try {
    const mod = await import('@inquirer/prompts');
    confirm = /** @type {any} */ (mod).confirm;
  } catch (error) {
    logger.warn(
      'Inquirer unavailable; assuming "No" for detail-scrape prompt.',
      { error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }

  const suffix = typeof itemCount === 'number' ? ` (${itemCount} items)` : '';
  return confirm({
    message: `Continue to scrape detail/info pages for ${label}${suffix}?`,
    default: true,
  });
}
