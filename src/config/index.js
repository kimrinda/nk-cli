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
 * Resolve an environment-supplied path (relative resolved against the
 * project root) or fall back to a project-relative default.
 *
 * @param {string | undefined} value Raw env value.
 * @param {string[]} fallback Path segments under the project root.
 * @returns {string} Absolute filesystem path.
 */
function pathEnv(value, fallback) {
  if (value && value.trim()) {
    return path.isAbsolute(value)
      ? value
      : path.resolve(projectRoot, value);
  }
  return path.join(projectRoot, ...fallback);
}

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
 * Parse a comma- or space-separated list of resource types to block at
 * the request-interception layer. Unknown tokens are silently dropped.
 *
 * @param {string | undefined} value Raw environment value.
 * @param {string[]} fallback Default list when `value` is missing.
 * @returns {string[]} Lowercase, deduplicated list of resource types.
 */
function resourceListEnv(value, fallback) {
  const known = new Set([
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'texttrack',
    'xhr',
    'fetch',
    'eventsource',
    'websocket',
    'manifest',
    'other',
  ]);
  if (!value) return [...fallback];
  if (value.trim().toLowerCase() === 'none') return [];
  const tokens = value
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => known.has(token));
  return [...new Set(tokens)];
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
 * @property {number} browser.wafTimeoutMs Generous wait used when the WAF challenge gates the real DOM.
 * @property {string|null} browser.executablePath Optional path to a real Chrome/Chromium binary.
 * @property {string} browser.channel Puppeteer browser channel hint (e.g. "chrome").
 * @property {string[]} browser.blockedResourceTypes Puppeteer resource types aborted before they hit the network.
 * @property {object} scrape Behavioural tuning for scrape loops.
 * @property {number} scrape.maxListingPages Hard cap on listing pages.
 * @property {number} scrape.maxDetailItems Hard cap on detail pages (0 = no cap).
 * @property {number} scrape.retryAttempts Retries per page before skipping.
 * @property {number} scrape.retryBaseDelayMs Base delay between retries.
 * @property {number} scrape.politeDelayMs Pause between successful requests.
 */

const outputDir = pathEnv(process.env.NK_OUTPUT_DIR, ['output']);
const logsDir = pathEnv(process.env.NK_LOGS_DIR, ['logs']);
const userDataDir = pathEnv(process.env.NK_USER_DATA_DIR, ['.browser_data']);

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
    output: outputDir,
    logs: logsDir,
    listingFile: path.join(outputDir, 'hanimeLists.json'),
    detailFile: path.join(outputDir, 'hanimeDetails.json'),
    detailProgressFile: path.join(outputDir, 'hanimeDetails.progress.json'),
    userDataDir,
  }),
  browser: Object.freeze({
    headless: boolEnv(process.env.NK_HEADLESS, true),
    viewportWidth: intEnv(process.env.NK_VIEWPORT_WIDTH, 1366),
    viewportHeight: intEnv(process.env.NK_VIEWPORT_HEIGHT, 768),
    navigationTimeoutMs: intEnv(process.env.NK_NAV_TIMEOUT_MS, 60_000),
    wafTimeoutMs: intEnv(process.env.NK_WAF_TIMEOUT_MS, 120_000),
    executablePath: process.env.NK_CHROME_EXECUTABLE_PATH ?? null,
    channel: process.env.NK_CHROME_CHANNEL ?? '',
    blockedResourceTypes: Object.freeze(
      resourceListEnv(process.env.NK_BLOCK_RESOURCES, ['image', 'media', 'font']),
    ),
  }),
  scrape: Object.freeze({
    maxListingPages: intEnv(process.env.NK_MAX_LIST_PAGES, 9999),
    maxDetailItems: intEnv(process.env.NK_MAX_DETAIL_ITEMS, 0),
    retryAttempts: intEnv(process.env.NK_RETRY_ATTEMPTS, 3),
    retryBaseDelayMs: intEnv(process.env.NK_RETRY_BASE_DELAY_MS, 2_500),
    politeDelayMs: intEnv(process.env.NK_POLITE_DELAY_MS, 800),
    thumbnailConcurrency: intEnv(process.env.NK_THUMBNAIL_CONCURRENCY, 10),
  }),
});
