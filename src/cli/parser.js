/**
 * @file Argv → action dispatcher built on `commander`.
 *
 * Maps the user-facing CLI commands to a small, well-typed
 * {@link CliAction} object that the runner in `main.js` consumes. The
 * parser intentionally does NOT execute any scraping logic — it simply
 * shapes intent so `main.js` stays the single orchestrator.
 */

import { Command, Option } from 'commander';

import { CATEGORIES } from '../config/categories.js';

/**
 * Dispatch action emitted by the parser.
 *
 * @typedef {(
 *   { type: 'listing', categoryKey: string }
 *   | { type: 'azIndex', categoryKey: string }
 *   | { type: 'detailBySlug', categoryKey: string, slug: string }
 *   | { type: 'detailByPage', categoryKey: string }
 * )} CliAction
 */

/**
 * Build the configured `Command` instance. Exposed for tests.
 *
 * @returns {Command} Top-level CLI program.
 */
export function buildProgram() {
  const program = new Command();
  program
    .name('nk-cli')
    .description('Puppeteer-based scraper for nekopoi.care categories.')
    .helpOption('-h, --help', 'Show help')
    .showHelpAfterError();

  /** @type {{ action: CliAction | null }} */
  const state = { action: null };

  // -- One sub-command per listing-shaped category. ------------------
  for (const category of Object.values(CATEGORIES)) {
    if (category.kind === 'listing') {
      program
        .command(category.command)
        .description(`Scrape the ${category.label} listing pages.`)
        .action(() => {
          state.action = { type: 'listing', categoryKey: category.key };
        });
    } else if (category.kind === 'azIndex') {
      program
        .command(category.command)
        .description(`Scrape the ${category.label} index page.`)
        .action(() => {
          state.action = { type: 'azIndex', categoryKey: category.key };
        });
    }
  }

  // -- scrape:info: per-slug or per-page detail-only run. ------------
  const listingCategoryKeys = Object.values(CATEGORIES)
    .filter((c) => c.kind === 'listing')
    .map((c) => c.key);

  program
    .command('scrape:info')
    .description(
      'Scrape detail/info pages — either a single slug (--slug) ' +
        'or every entry in a previously-saved category listing (--page).',
    )
    .addOption(new Option('-s, --slug <slug>', 'Single slug to scrape'))
    .addOption(
      new Option(
        '-p, --page <category>',
        'Category whose saved listing should be detail-scraped',
      ).choices(listingCategoryKeys),
    )
    .addOption(
      new Option(
        '-c, --category <category>',
        'Category context for --slug (URL building)',
      ).choices(listingCategoryKeys).default('hanime'),
    )
    .action((opts) => {
      const slug = opts.slug;
      const pageKey = opts.page;
      if (!slug && !pageKey) {
        throw new Error(
          'scrape:info requires either --slug <slug> or --page <category>',
        );
      }
      if (slug && pageKey) {
        throw new Error(
          'scrape:info: --slug and --page are mutually exclusive',
        );
      }
      state.action = pageKey
        ? { type: 'detailByPage', categoryKey: pageKey }
        : { type: 'detailBySlug', categoryKey: opts.category, slug };
    });

  // -- Internal accessor so parseArgs(...) can return the action. ----
  /** @type {Command & { __getAction?: () => CliAction | null }} */ (program)
    .__getAction = () => state.action;

  return program;
}

/**
 * Parse a raw argv slice into a {@link CliAction}.
 *
 * @param {string[]} argv `process.argv` (the full array, including
 *   the node binary path and script path — commander handles the slice).
 * @returns {Promise<CliAction>} The parsed action.
 * @throws {Error} When no recognised command was supplied.
 */
export async function parseArgs(argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
  const get = /** @type {Command & { __getAction?: () => CliAction | null }} */ (
    program
  ).__getAction;
  const action = typeof get === 'function' ? get() : null;
  if (!action) {
    throw new Error(
      'No command supplied. Run with --help to see available commands.',
    );
  }
  return action;
}
