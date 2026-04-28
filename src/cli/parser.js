/**
 * @file Argv → action dispatcher built on `argparse`.
 *
 * Implements the new flag-style CLI:
 *
 *   node main.js --scrape <name> --method <cli|browser> [--slug ...]
 *                [--page <key>] [--category <key>]
 *
 * The `<name>` token is the same for both methods and accepts:
 *
 *   * `<categoryKey>`         — run the listing / AZ-index for that
 *                               category (e.g. `hanime`, `hanimeindex`).
 *   * `<categoryKey>info`     — run the detail/info phase for that
 *                               category. Combine with `--slug` for a
 *                               single-page scrape, or `--page` to
 *                               replay an existing on-disk listing.
 *   * `info`                  — generic detail scrape; combine with
 *                               `--slug --category` or `--page`.
 *
 * The parser intentionally does NOT execute any scraping logic — it
 * shapes the user intent into a {@link CliAction} object so `main.js`
 * can stay the single orchestrator.
 */

import { ArgumentParser, RawDescriptionHelpFormatter } from 'argparse';

import { CATEGORIES } from '../config/categories.js';

/**
 * Scrape engine selector.
 *
 * @typedef {'cli'|'browser'} ScrapeMethod
 */

/**
 * Dispatch action emitted by the parser.
 *
 * @typedef {(
 *   { type: 'listing', categoryKey: string, method: ScrapeMethod }
 *   | { type: 'azIndex', categoryKey: string, method: ScrapeMethod }
 *   | { type: 'detailBySlug', categoryKey: string, slug: string, method: ScrapeMethod }
 *   | { type: 'detailByPage', categoryKey: string, method: ScrapeMethod }
 * )} CliAction
 */

/**
 * Allowed `--scrape` token shapes derived from the category registry.
 *
 * @returns {{
 *   listingTokens: string[],
 *   azIndexTokens: string[],
 *   infoTokens: string[],
 *   infoTokenToCategory: Record<string, string>,
 * }} Grouped token sets.
 */
function describeScrapeTokens() {
  /** @type {string[]} */
  const listingTokens = [];
  /** @type {string[]} */
  const azIndexTokens = [];
  /** @type {string[]} */
  const infoTokens = [];
  /** @type {Record<string, string>} */
  const infoTokenToCategory = {};

  for (const category of Object.values(CATEGORIES)) {
    if (category.kind === 'listing') {
      listingTokens.push(category.key);
      const infoToken = `${category.key}info`;
      infoTokens.push(infoToken);
      infoTokenToCategory[infoToken] = category.key;
    } else if (category.kind === 'azIndex') {
      azIndexTokens.push(category.key);
    }
  }
  // Generic alias, useful when combined with --category.
  infoTokens.push('info');
  return { listingTokens, azIndexTokens, infoTokens, infoTokenToCategory };
}

/**
 * Build the configured `ArgumentParser`. Exposed for tests.
 *
 * @returns {ArgumentParser} Top-level argparse parser.
 */
export function buildParser() {
  const tokens = describeScrapeTokens();
  const allScrapeTokens = [
    ...tokens.listingTokens,
    ...tokens.azIndexTokens,
    ...tokens.infoTokens,
  ];

  const parser = new ArgumentParser({
    prog: 'nk-cli',
    description:
      'Dual-engine scraper for nekopoi.care. Pick a scraping target ' +
      'with --scrape and an engine with --method.',
    formatter_class: RawDescriptionHelpFormatter,
    epilog: [
      'Examples:',
      '  node main.js --scrape hanime --method cli',
      '  node main.js --scrape hanime --method browser',
      '  node main.js --scrape hanimeinfo --slug my-slug --method cli',
      '  node main.js --scrape info --category hanime --page hanime --method cli',
      '  node main.js --scrape hanimeindex --method browser',
    ].join('\n'),
  });

  parser.add_argument('--scrape', {
    required: true,
    choices: allScrapeTokens,
    help:
      'Scrape target. ' +
      `Listing categories: ${tokens.listingTokens.join(', ')}. ` +
      `AZ-index categories: ${tokens.azIndexTokens.join(', ')}. ` +
      `Detail/info targets: ${tokens.infoTokens.join(', ')}.`,
  });
  parser.add_argument('--method', {
    required: false,
    default: 'browser',
    choices: ['cli', 'browser'],
    help: 'Scraping engine: "cli" (axios + cheerio) or "browser" (puppeteer). Defaults to "browser".',
  });
  parser.add_argument('-s', '--slug', {
    required: false,
    default: null,
    help: 'Single slug to scrape (used with --scrape <key>info or --scrape info).',
  });
  parser.add_argument('-p', '--page', {
    required: false,
    default: null,
    choices: tokens.listingTokens,
    help: 'Replay a previously-saved listing for this category through the detail phase.',
  });
  parser.add_argument('-c', '--category', {
    required: false,
    default: 'hanime',
    choices: tokens.listingTokens,
    help: 'Category context for --slug when --scrape is the generic "info" token. Defaults to "hanime".',
  });

  return parser;
}

/**
 * Resolve a parsed `--scrape` token + supporting flags into a typed
 * {@link CliAction}.
 *
 * @param {Record<string, string | null>} args Parsed argparse object.
 * @returns {CliAction} Typed action consumed by `main.js`.
 * @throws {Error} When the supplied flag combination is invalid.
 */
function resolveAction(args) {
  const tokens = describeScrapeTokens();
  const scrape = String(args.scrape);
  const method = /** @type {ScrapeMethod} */ (args.method ?? 'browser');
  const slug = args.slug ? String(args.slug) : null;
  const pageKey = args.page ? String(args.page) : null;
  const categoryArg = args.category ? String(args.category) : 'hanime';

  if (tokens.listingTokens.includes(scrape)) {
    return { type: 'listing', categoryKey: scrape, method };
  }
  if (tokens.azIndexTokens.includes(scrape)) {
    return { type: 'azIndex', categoryKey: scrape, method };
  }

  // --scrape <key>info or --scrape info.
  /** @type {string} */
  let categoryKey;
  if (scrape === 'info') {
    categoryKey = categoryArg;
  } else {
    categoryKey = tokens.infoTokenToCategory[scrape];
    if (!categoryKey) {
      throw new Error(`Unrecognised --scrape value "${scrape}"`);
    }
  }

  if (slug && pageKey) {
    throw new Error('--slug and --page are mutually exclusive');
  }
  if (slug) {
    return { type: 'detailBySlug', categoryKey, slug, method };
  }
  const resolvedPageKey = pageKey ?? categoryKey;
  return { type: 'detailByPage', categoryKey: resolvedPageKey, method };
}

/**
 * Parse a raw argv slice into a {@link CliAction}.
 *
 * @param {string[]} argv `process.argv` (the full array, including the
 *   node binary path and script path — argparse handles the slice).
 * @returns {Promise<CliAction>} The parsed action.
 * @throws {Error} When required arguments are missing or the
 *   combination of flags is invalid.
 */
export async function parseArgs(argv) {
  const parser = buildParser();
  const args = parser.parse_args(argv.slice(2));
  return resolveAction(/** @type {Record<string, string | null>} */ (args));
}
