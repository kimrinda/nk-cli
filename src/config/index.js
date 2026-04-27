/**
 * @file Centralised runtime configuration for the nk-cli scraper.
 *
 * Values can be tuned via environment variables without modifying source.
 * All paths are absolute and resolved against the project root.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {string} Absolute path to the project root. */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * Parse an environment variable as a positive integer, falling back to a default.
 *
 * @param {string | undefined} value Raw environment value.
 * @param {number} fallback Default value used when `value` is missing/invalid.
 * @returns {number} A safe positive integer.
 */
function intEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse an environment variable as a boolean. Truthy values: `1`, `true`, `yes`.
 *
 * @param {string | undefined} value Raw environment value.
 * @param {boolean} fallback Default value used when `value` is missing.
 * @returns {boolean} Coerced boolean.
 */
function boolEnv(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Immutable configuration consumed by every module.
 *
 * @typedef {object} ScraperConfig
 * @property {string} baseUrl Root URL of the target site.
 * @property {string} homeUrl Homepage that exposes the Hentai menu.
 * @property {string} userAgent Realistic desktop UA presented to the site.
 * @property {object} paths Resolved filesystem paths.
 * @property {string} paths.root Project root.
 * @property {string} paths.output Directory for JSON outputs.
 * @property {string} paths.logs Directory for log files.
 * @property {string} paths.listingFile Final listing JSON path.
 * @property {string} paths.detailFile Final merged detail JSON path.
 * @property {string} paths.detailProgressFile Per-slug progress checkpoints.
 * @property {string} paths.userDataDir Puppeteer profile persistence dir.
 * @property {object} browser Puppeteer launch tuning.
 * @property {boolean} browser.headless Whether to run headless.
 * @property {number} browser.viewportWidth Default viewport width.
 * @property {number} browser.viewportHeight Default viewport height.
 * @property {number} browser.navigationTimeoutMs Default navigation timeout.
 * @property {string|null} browser.executablePath Optional path to a real Chrome/Chromium binary.
 * @property {string} browser.channel Puppeteer browser channel hint (e.g. "chrome").
 * @property {object} scrape Behavioural tuning for scrape loops.
 * @property {number} scrape.maxListingPages Hard cap on listing pages.
 * @property {number} scrape.maxDetailItems Hard cap on detail pages (0 = no cap).
 * @property {number} scrape.retryAttempts Retries per page before skipping.
 * @property {number} scrape.retryBaseDelayMs Base delay between retries.
 * @property {number} scrape.politeDelayMs Pause between successful requests.
 */

/** @type {ScraperConfig} */
export const config = Object.freeze({
  baseUrl: process.env.NK_BASE_URL ?? 'https://nekopoi.care',
  homeUrl: process.env.NK_HOME_URL ?? 'https://nekopoi.care/',
  userAgent:
    process.env.NK_USER_AGENT ??
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  paths: Object.freeze({
    root: projectRoot,
    output: path.join(projectRoot, 'output'),
    logs: path.join(projectRoot, 'logs'),
    listingFile: path.join(projectRoot, 'output', 'hanimeLists.json'),
    detailFile: path.join(projectRoot, 'output', 'hanimeDetails.json'),
    detailProgressFile: path.join(
      projectRoot,
      'output',
      'hanimeDetails.progress.json',
    ),
    userDataDir: path.join(projectRoot, '.browser_data'),
  }),
  browser: Object.freeze({
    headless: boolEnv(process.env.NK_HEADLESS, true),
    viewportWidth: intEnv(process.env.NK_VIEWPORT_WIDTH, 1366),
    viewportHeight: intEnv(process.env.NK_VIEWPORT_HEIGHT, 768),
    navigationTimeoutMs: intEnv(process.env.NK_NAV_TIMEOUT_MS, 60_000),
    executablePath: process.env.NK_CHROME_EXECUTABLE_PATH ?? null,
    channel: process.env.NK_CHROME_CHANNEL ?? '',
  }),
  scrape: Object.freeze({
    maxListingPages: intEnv(process.env.NK_MAX_LIST_PAGES, 9999),
    maxDetailItems: intEnv(process.env.NK_MAX_DETAIL_ITEMS, 0),
    retryAttempts: intEnv(process.env.NK_RETRY_ATTEMPTS, 3),
    retryBaseDelayMs: intEnv(process.env.NK_RETRY_BASE_DELAY_MS, 2_500),
    politeDelayMs: intEnv(process.env.NK_POLITE_DELAY_MS, 800),
  }),
});
