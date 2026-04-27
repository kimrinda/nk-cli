/**
 * @file Thin wrapper around `@inquirer/prompts` with a non-interactive
 * fallback so tests / CI / piped runs never hang.
 *
 * Two families of prompts live here:
 *
 *   * {@link confirmDetailScrape} — the original Y/N gate between the
 *     listing and detail phases (`NK_AUTO_DETAIL=yes|no` overrides).
 *   * {@link confirmResume} / {@link confirmOverwrite} — tri-state
 *     `Yes / No / Cancel` prompts that drive the resume-from-progress
 *     flow (`NK_RESUME=yes|no|cancel`,
 *     `NK_RESUME_OVERWRITE=yes|no|cancel`).
 *
 * `@inquirer/prompts` is loaded via dynamic import so the rest of the
 * CLI stays usable even if the dep is missing on a minimal install.
 */

import { logger } from '../utils/logger.js';

/**
 * Tri-state value used by the resume / overwrite prompts.
 *
 * @typedef {'yes'|'no'|'cancel'} TriState
 */

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
 * Parse a tri-state environment override.
 *
 * @param {string} envName Environment variable name to read.
 * @returns {TriState | null} Tri-state value or `null` when unset/invalid.
 */
function readTriStateEnv(envName) {
  const raw = (process.env[envName] ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return 'yes';
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return 'no';
  if (['cancel', 'abort', 'c'].includes(raw)) return 'cancel';
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

/**
 * Lazily import `@inquirer/prompts.select`. Returns `null` when the
 * package is unavailable so callers can safely fall back to a default.
 *
 * @returns {Promise<((q: object) => Promise<string>) | null>} Loaded
 *   `select` function or `null`.
 */
async function loadSelect() {
  try {
    const mod = await import('@inquirer/prompts');
    return /** @type {any} */ (mod).select ?? null;
  } catch (error) {
    logger.warn('Inquirer unavailable; resume prompt will use defaults.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Render a tri-state `Yes / No / Cancel` prompt. Resolves env overrides
 * and non-TTY fallbacks before falling back to inquirer's `select`.
 *
 * @param {object} options
 * @param {string} options.message Prompt question shown to the user.
 * @param {string} options.envName Environment variable that can pre-answer.
 * @param {TriState} options.nonTtyDefault Value used when stdin is not a TTY.
 * @param {TriState} [options.defaultChoice] Default-selected option.
 * @returns {Promise<TriState>} The resolved tri-state value.
 */
async function triStatePrompt(options) {
  const { message, envName, nonTtyDefault, defaultChoice = 'yes' } = options;

  const fromEnv = readTriStateEnv(envName);
  if (fromEnv !== null) {
    logger.info('Tri-state prompt resolved by env override', {
      env: envName,
      value: process.env[envName],
      decision: fromEnv,
    });
    return fromEnv;
  }

  if (!process.stdin.isTTY) {
    logger.info(
      `Tri-state prompt "${message}" skipped (non-interactive stdin); ` +
        `assuming "${nonTtyDefault}". Set ${envName} to override.`,
    );
    return nonTtyDefault;
  }

  const select = await loadSelect();
  if (!select) return nonTtyDefault;

  /** @type {string} */
  const value = await select({
    message,
    default: defaultChoice,
    choices: [
      { name: 'Yes', value: 'yes' },
      { name: 'No', value: 'no' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });
  return /** @type {TriState} */ (value);
}

/**
 * Ask the user whether to resume from a previously-saved progress meta.
 *
 * Reads `NK_RESUME` for a non-interactive override and falls back to
 * `'cancel'` when stdin is not a TTY (safest: nothing is mutated).
 *
 * @returns {Promise<TriState>} Tri-state user decision.
 */
export async function confirmResume() {
  return triStatePrompt({
    message:
      'An unfinished scraping progress was found. ' +
      'Continue from the last saved index?',
    envName: 'NK_RESUME',
    nonTtyDefault: 'cancel',
    defaultChoice: 'yes',
  });
}

/**
 * Ask the user to confirm a destructive overwrite of an existing
 * progress meta and output file before starting a fresh run.
 *
 * Reads `NK_RESUME_OVERWRITE` for a non-interactive override and falls
 * back to `'cancel'` when stdin is not a TTY.
 *
 * @returns {Promise<TriState>} Tri-state user decision.
 */
export async function confirmOverwrite() {
  return triStatePrompt({
    message:
      'This will overwrite the previously saved progress and output ' +
      'data. Are you sure?',
    envName: 'NK_RESUME_OVERWRITE',
    nonTtyDefault: 'cancel',
    defaultChoice: 'no',
  });
}
