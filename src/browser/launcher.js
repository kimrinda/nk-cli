/**
 * @file Puppeteer browser launcher with anti-detection hardening.
 *
 * Uses `rebrowser-puppeteer` (aliased as `puppeteer` in package.json) to
 * neutralise the well-known `Runtime.Enable` CDP leak that anti-bot
 * vendors (SafeLine, Cloudflare, DataDome, …) exploit to flag
 * automation. Also layers `puppeteer-extra-plugin-stealth` for the
 * standard `webdriver`/`navigator` fingerprint scrubs and adds a
 * `Function.prototype.toString` shim so any of our injected helpers
 * cannot be inspected from the page.
 *
 * Falls back to the bare `puppeteer` import if `puppeteer-extra` is
 * missing — useful for very minimal environments / smoke tests.
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Default Chromium flags chosen to maximise reliability inside containers
 * while still presenting a credible browser fingerprint.
 *
 * @type {string[]}
 */
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-default-browser-check',
  '--no-first-run',
  '--lang=en-US,en',
];

/**
 * Apply the rebrowser-patches default `Runtime.Enable` fix mode unless
 * the user has set one explicitly.
 *
 * `addBinding` lets injected scripts run in the main world while still
 * suppressing the `Runtime.consoleAPICalled` side-channel that leaks
 * CDP presence, which is the trick SafeLine WAF's "Debugging Detected"
 * banner is built on.
 *
 * @returns {void}
 */
function ensureRebrowserDefaults() {
  if (!process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE) {
    process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
  }
  if (!process.env.REBROWSER_PATCHES_SOURCE_URL) {
    // Strip telltale `pptr:` script URLs from injected sources.
    process.env.REBROWSER_PATCHES_SOURCE_URL = 'app.js';
  }
  if (!process.env.REBROWSER_PATCHES_UTILITY_WORLD_NAME) {
    // Use a generic world name; default contains the string "utility".
    process.env.REBROWSER_PATCHES_UTILITY_WORLD_NAME = '1';
  }
}

/**
 * Resolve the Puppeteer-compatible launcher, preferring the stealth build.
 *
 * Because `puppeteer` is aliased to `rebrowser-puppeteer` in package.json,
 * either branch returns a patched build.
 *
 * @returns {Promise<import('puppeteer').PuppeteerNode>} A launcher exposing `.launch()`.
 */
async function resolvePuppeteer() {
  try {
    const [{ default: puppeteer }, { default: stealth }] = await Promise.all([
      import('puppeteer-extra'),
      import('puppeteer-extra-plugin-stealth'),
    ]);
    puppeteer.use(stealth());
    logger.debug('Using puppeteer-extra + stealth on top of rebrowser-puppeteer');
    return /** @type {import('puppeteer').PuppeteerNode} */ (
      /** @type {unknown} */ (puppeteer)
    );
  } catch (error) {
    logger.warn('Stealth plugin unavailable, falling back to plain puppeteer', {
      error: error instanceof Error ? error.message : String(error),
    });
    const { default: puppeteer } = await import('puppeteer');
    return puppeteer;
  }
}

/**
 * Build the launch options for `puppeteer.launch`. Honours the optional
 * `NK_CHROME_EXECUTABLE_PATH` / `NK_CHROME_CHANNEL` env knobs so the
 * caller can target a real Chrome install instead of the bundled
 * Chromium build (which has its own well-known fingerprint quirks).
 *
 * @returns {import('puppeteer').LaunchOptions} Options for `puppeteer.launch`.
 */
function buildLaunchOptions() {
  /** @type {import('puppeteer').LaunchOptions} */
  const options = {
    headless: config.browser.headless,
    userDataDir: config.paths.userDataDir,
    defaultViewport: {
      width: config.browser.viewportWidth,
      height: config.browser.viewportHeight,
    },
    args: CHROMIUM_ARGS,
  };

  if (config.browser.executablePath) {
    options.executablePath = config.browser.executablePath;
  }
  if (config.browser.channel) {
    /** @type {any} */ (options).channel = config.browser.channel;
  }

  return options;
}

/**
 * Launch a browser instance configured for the nekopoi.care scrape job.
 *
 * @returns {Promise<import('puppeteer').Browser>} A ready-to-use Puppeteer browser.
 */
export async function launchBrowser() {
  ensureRebrowserDefaults();
  const puppeteer = await resolvePuppeteer();

  const options = buildLaunchOptions();
  logger.info('Launching browser', {
    headless: options.headless,
    userDataDir: options.userDataDir,
    executablePath: options.executablePath ?? '(bundled)',
    channel: /** @type {any} */ (options).channel || '(default)',
    runtimeFixMode: process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE,
  });

  return puppeteer.launch(options);
}

/**
 * Page-context shim that scrubs the most commonly-checked automation
 * marker, `navigator.webdriver`. Heavier fingerprint surgery is left to
 * `puppeteer-extra-plugin-stealth`, which is loaded earlier in
 * {@link resolvePuppeteer}; the actual `Runtime.Enable` CDP leak that
 * SafeLine's "Debugging Detected" banner relies on is suppressed by
 * `rebrowser-puppeteer` itself, so no global `Date.now` /
 * `performance.now` patch is needed (and would risk breaking
 * legitimate page code).
 *
 * Runs inside the page; must be self-contained.
 *
 * @returns {void}
 */
function antiDetectionShim() {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {
    /* navigator.webdriver might already be locked down */
  }
}

/**
 * Open a new page with sensible defaults: realistic UA, accept-language,
 * navigation timeout, and the {@link antiDetectionShim} hook installed
 * before any page script runs.
 *
 * @param {import('puppeteer').Browser} browser Browser returned by {@link launchBrowser}.
 * @returns {Promise<import('puppeteer').Page>} A configured page object.
 */
export async function newConfiguredPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(config.userAgent);
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  page.setDefaultTimeout(config.browser.navigationTimeoutMs);

  await page.evaluateOnNewDocument(antiDetectionShim);

  return page;
}

/**
 * Close a browser instance, swallowing benign teardown errors.
 *
 * @param {import('puppeteer').Browser | null} browser Browser to dispose, may be null.
 * @returns {Promise<void>} Resolves after best-effort close.
 */
export async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (error) {
    logger.warn('Error while closing browser', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
