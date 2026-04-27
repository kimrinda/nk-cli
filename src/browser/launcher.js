/**
 * @file Puppeteer browser launcher with optional stealth hardening.
 *
 * Tries `puppeteer-extra` + `puppeteer-extra-plugin-stealth` first, and
 * falls back to vanilla `puppeteer` if the optional dependency is missing.
 * Either way the returned API matches Puppeteer's `Browser` interface.
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
 * Resolve the Puppeteer-compatible launcher, preferring the stealth build.
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
    logger.debug('Using puppeteer-extra with stealth plugin');
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
 * Launch a browser instance configured for the nekopoi.care scrape job.
 *
 * @returns {Promise<import('puppeteer').Browser>} A ready-to-use Puppeteer browser.
 */
export async function launchBrowser() {
  const puppeteer = await resolvePuppeteer();

  logger.info('Launching browser', {
    headless: config.browser.headless,
    userDataDir: config.paths.userDataDir,
  });

  const browser = await puppeteer.launch({
    headless: config.browser.headless,
    userDataDir: config.paths.userDataDir,
    defaultViewport: {
      width: config.browser.viewportWidth,
      height: config.browser.viewportHeight,
    },
    args: CHROMIUM_ARGS,
  });

  return browser;
}

/**
 * Open a new page with sensible defaults: realistic UA, accept-language,
 * navigation timeout, and a lightweight `webdriver`-flag scrub.
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

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

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
