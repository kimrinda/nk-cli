/**
 * @file Cheerio (HTTP-mode) `#nk-player` parser.
 *
 * Mirrors `src/parsers/nkPlayer.js` but works against a static HTML
 * tree parsed by cheerio.
 */

import { load } from 'cheerio';

/**
 * @typedef {import('../nkPlayer.js').PlayerData} PlayerData
 * @typedef {import('../nkPlayer.js').StreamServer} StreamServer
 * @typedef {import('../nkPlayer.js').EpisodeNavLink} EpisodeNavLink
 */

/**
 * Parse the detail-page HTML and produce the same {@link PlayerData}
 * record as the browser-side extractor.
 *
 * @param {string} html Raw HTML body for the detail page.
 * @param {string} pageUrl Absolute URL of the page (used to resolve
 *   relative `href` values on episode-nav anchors).
 * @returns {PlayerData} Parsed player data.
 */
export function parseNkPlayerHtml(html, pageUrl) {
  const $ = load(html);
  /** @type {PlayerData} */
  const data = {
    title: '',
    servers: [],
    episodeNav: { prev: null, next: null },
  };

  const player = $('#nk-player').first();
  if (!player.length) return data;

  // Title — first text node of the section header (avoids picking up
  // child <small>/<span> elements).
  const headerH1 = player.find('.nk-section-header h1').first();
  if (headerH1.length) {
    const firstChild = headerH1[0].children?.[0];
    if (firstChild && 'data' in firstChild) {
      data.title = (
        /** @type {{data: string}} */ (firstChild).data || ''
      ).trim();
    }
  }

  /** @type {StreamServer[]} */
  const servers = [];
  player.find("#nk-player-tabs a[href^='#nk-stream-']").each((_, tabEl) => {
    const tab = $(tabEl);
    const id = tab.attr('href') ?? '';
    const frame = id ? player.find(id).first() : $();
    const iframe = frame.find('iframe').first();
    const src = iframe.attr('src') ?? '';
    if (!src) return;
    servers.push({
      name: (tab.text() || '').trim(),
      id: id.replace('#', ''),
      url: src,
      width: iframe.attr('width') ?? '',
      height: iframe.attr('height') ?? '',
      allowFullscreen:
        iframe.attr('allowfullscreen') !== undefined ||
        iframe.attr('allowFullScreen') !== undefined,
    });
  });
  data.servers = servers;

  /**
   * Build an {@link EpisodeNavLink} from a `<a>` element, or return null.
   *
   * @param {ReturnType<typeof $>} sel Cheerio selection.
   * @returns {EpisodeNavLink | null}
   */
  function navFrom(sel) {
    if (!sel.length) return null;
    const href = sel.attr('href') ?? '';
    if (!href) return null;
    let absolute = href;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      absolute = href;
    }
    return { title: (sel.text() || '').trim(), url: absolute };
  }

  data.episodeNav.prev = navFrom(player.find('.nk-episode-prev').first());
  data.episodeNav.next = navFrom(player.find('.nk-episode-next').first());

  return data;
}
