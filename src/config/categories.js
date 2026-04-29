/**
 * @file Registry of every scraping target the CLI knows about.
 *
 * Adding a new target is a one-stop change: append an entry here, expose
 * a CLI command in `src/cli/parser.js`, and the rest of the pipeline
 * (listing scraper, detail scraper, output paths) picks it up
 * automatically.
 */

import path from 'node:path';

import { config } from './index.js';

/**
 * Category descriptor consumed by the scraper services.
 *
 * @typedef {object} CategoryDefinition
 * @property {string} key Stable identifier used by the CLI command (e.g. `hanime`).
 * @property {string} command Full CLI command name (e.g. `scrape:hanime`).
 * @property {string} label Human-readable label for log output.
 * @property {string} menuText Menu text shown on the homepage; used to find and click the link (case-insensitive, whitespace-collapsed).
 * @property {string} slug URL slug under the site root (`hentai`, `2d-animation`, …).
 * @property {'listing'|'azIndex'} kind Listing layout used by this target.
 * @property {string} listingFileName Filename for listing/index output.
 * @property {string=} detailFileName Legacy filename for the monolithic combined-detail output. Kept only so old runs can be migrated into the per-prefix split layout (see `detailDirName` / `detailFilenamePrefix`).
 * @property {string=} detailProgressFileName Legacy per-slug progress checkpoint filename. Replaced by the per-prefix bucket files but still consulted on resume for migrations.
 * @property {string=} detailDirName Directory (relative to `output/details/`) holding the per-prefix detail bucket files. Defaults to `key`.
 * @property {string=} detailFilenamePrefix Common filename prefix for every per-prefix bucket file (e.g. `hanimeDetails`).
 */

/**
 * Resolve a filename against the configured output directory.
 *
 * @param {string} fileName Bare filename without directory parts.
 * @returns {string} Absolute path under `config.paths.output`.
 */
function outputPath(fileName) {
  return path.join(config.paths.output, fileName);
}

/**
 * @typedef {CategoryDefinition & {
 *   listingPath: string,
 *   detailPath: string | null,
 *   detailProgressPath: string | null,
 *   detailDir: string | null,
 *   detailFilenamePrefix: string | null,
 *   detailManifestPath: string | null,
 * }} ResolvedCategory
 */

/**
 * Materialise a {@link CategoryDefinition} with absolute output paths.
 *
 * @param {CategoryDefinition} def Raw category definition.
 * @returns {ResolvedCategory} Definition extended with absolute paths.
 */
function resolve(def) {
  const hasDetail = Boolean(def.detailFilenamePrefix);
  const detailDir = hasDetail
    ? path.join(
        config.paths.output,
        'details',
        def.detailDirName ?? def.key,
      )
    : null;
  const detailManifestPath =
    hasDetail && detailDir
      ? path.join(detailDir, `${def.detailFilenamePrefix}.manifest.json`)
      : null;
  return Object.freeze({
    ...def,
    listingPath: outputPath(def.listingFileName),
    detailPath: def.detailFileName ? outputPath(def.detailFileName) : null,
    detailProgressPath: def.detailProgressFileName
      ? outputPath(def.detailProgressFileName)
      : null,
    detailDir,
    detailFilenamePrefix: def.detailFilenamePrefix ?? null,
    detailManifestPath,
  });
}

/**
 * Every supported category, keyed by its CLI key.
 *
 * @type {Readonly<Record<string, ResolvedCategory>>}
 */
export const CATEGORIES = Object.freeze({
  hanime: resolve({
    key: 'hanime',
    command: 'scrape:hanime',
    label: 'Hanime / Hentai',
    menuText: 'hentai',
    slug: 'hentai',
    kind: 'listing',
    listingFileName: 'hanimeLists.json',
    detailFileName: 'hanimeDetails.json',
    detailProgressFileName: 'hanimeDetails.progress.json',
    detailDirName: 'hanime',
    detailFilenamePrefix: 'hanimeDetails',
  }),
  '2d-animation': resolve({
    key: '2d-animation',
    command: 'scrape:2d-animation',
    label: '2D Animation',
    menuText: '2d animation',
    slug: '2d-animation',
    kind: 'listing',
    listingFileName: '2dAnimationLists.json',
    detailFileName: '2dAnimationDetails.json',
    detailProgressFileName: '2dAnimationDetails.progress.json',
    detailDirName: '2d-animation',
    detailFilenamePrefix: '2dAnimationDetails',
  }),
  '3d-hentai': resolve({
    key: '3d-hentai',
    command: 'scrape:3d-hentai',
    label: '3D Hentai',
    menuText: '3d hentai',
    slug: '3d-hentai',
    kind: 'listing',
    listingFileName: '3dHentaiLists.json',
    detailFileName: '3dHentaiDetails.json',
    detailProgressFileName: '3dHentaiDetails.progress.json',
    detailDirName: '3d-hentai',
    detailFilenamePrefix: '3dHentaiDetails',
  }),
  'jav-cosplay': resolve({
    key: 'jav-cosplay',
    command: 'scrape:jav-cosplay',
    label: 'JAV Cosplay',
    menuText: 'jav cosplay',
    slug: 'jav-cosplay',
    kind: 'listing',
    listingFileName: 'javCosplayLists.json',
    detailFileName: 'javCosplayDetails.json',
    detailProgressFileName: 'javCosplayDetails.progress.json',
    detailDirName: 'jav-cosplay',
    detailFilenamePrefix: 'javCosplayDetails',
  }),
  jav: resolve({
    key: 'jav',
    command: 'scrape:jav',
    label: 'JAV',
    menuText: 'jav',
    slug: 'jav',
    kind: 'listing',
    listingFileName: 'javLists.json',
    detailFileName: 'javDetails.json',
    detailProgressFileName: 'javDetails.progress.json',
    detailDirName: 'jav',
    detailFilenamePrefix: 'javDetails',
  }),
  hanimeindex: resolve({
    key: 'hanimeindex',
    command: 'scrape:hanimeindex',
    label: 'Hentai List (A–Z index)',
    menuText: 'hentai list',
    slug: 'hentai-list',
    kind: 'azIndex',
    listingFileName: 'hanimeIndex.json',
  }),
});

/**
 * Look up a category by its CLI key.
 *
 * @param {string} key CLI key (e.g. `hanime`, `2d-animation`).
 * @returns {ResolvedCategory} Resolved category definition.
 * @throws {Error} When the key is not registered.
 */
export function getCategory(key) {
  const entry = CATEGORIES[key];
  if (!entry) {
    const known = Object.keys(CATEGORIES).join(', ');
    throw new Error(`Unknown category key "${key}". Known: ${known}`);
  }
  return entry;
}

/**
 * Compute the per-slug detail URL for the given category.
 *
 * The site uses two URL conventions: top-level `/<slug>/` for hanime
 * and per-category `/<categorySlug>/<slug>/` for the others. We always
 * trust an explicit `url` carried on the listing item if present.
 *
 * @param {ResolvedCategory} category Resolved category.
 * @param {{slug: string, url?: string}} item Listing item to expand.
 * @returns {string} Absolute detail URL.
 */
export function buildDetailUrl(category, item) {
  if (item.url) return item.url;
  const root = config.baseUrl.replace(/\/$/, '');
  if (category.slug === 'hentai') {
    return `${root}/${item.slug}/`;
  }
  return `${root}/${category.slug}/${item.slug}/`;
}

/**
 * Build the absolute URL for a listing/index landing page.
 *
 * @param {ResolvedCategory} category Resolved category.
 * @returns {string} Absolute URL.
 */
export function buildCategoryUrl(category) {
  const root = config.baseUrl.replace(/\/$/, '');
  return category.kind === "azIndex" ? `${root}/${category.slug}` : `${root}/category/${category.slug}/`;
}
