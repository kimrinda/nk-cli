/**
 * @file Streaming player parser for the `#nk-player` block.
 *
 * Captures the available stream servers along with their iframe URLs and
 * the prev/next episode navigation links if present.
 */

/**
 * Single streaming server entry exposed by `#nk-player-tabs`.
 *
 * @typedef {object} StreamServer
 * @property {string} name Server label (e.g. "Mirror 1").
 * @property {string} id Tab identifier (without the leading `#`).
 * @property {string} url Iframe `src` URL (player embed).
 * @property {string} width Iframe width attribute.
 * @property {string} height Iframe height attribute.
 * @property {boolean} allowFullscreen Whether the iframe permits fullscreen.
 */

/**
 * Episode navigation entry parsed from `.nk-episode-prev`/`.nk-episode-next`.
 *
 * @typedef {object} EpisodeNavLink
 * @property {string} title Visible link text.
 * @property {string} url Absolute href.
 */

/**
 * Result type returned by {@link parseNkPlayer}.
 *
 * @typedef {object} PlayerData
 * @property {string} title Player section title.
 * @property {StreamServer[]} servers Available streaming servers.
 * @property {{prev: EpisodeNavLink|null, next: EpisodeNavLink|null}} episodeNav
 *   Adjacent-episode navigation links (null when absent).
 */

/**
 * Browser-side extractor for `#nk-player`.
 *
 * @returns {PlayerData} The parsed player block, with empty arrays when absent.
 */
export function parseNkPlayer() {
  /** @type {PlayerData} */
  const data = {
    title: '',
    servers: [],
    episodeNav: { prev: null, next: null },
  };

  const el = document.querySelector('#nk-player');
  if (!el) return data;

  data.title =
    el
      .querySelector('.nk-section-header h1')
      ?.childNodes?.[0]?.textContent?.trim() ?? '';

  data.servers = [
    ...el.querySelectorAll("#nk-player-tabs a[href^='#nk-stream-']"),
  ]
    .map((tab) => {
      const id = tab.getAttribute('href') ?? '';
      const frame = id ? el.querySelector(id) : null;
      const iframe = frame?.querySelector('iframe') ?? null;
      return {
        name: tab.textContent?.trim() ?? '',
        id: id.replace('#', ''),
        url: iframe?.getAttribute('src') ?? '',
        width: iframe?.getAttribute('width') ?? '',
        height: iframe?.getAttribute('height') ?? '',
        allowFullscreen: Boolean(
          iframe instanceof HTMLIFrameElement && iframe.allowFullscreen,
        ),
      };
    })
    .filter((server) => server.url);

  const prev = el.querySelector('.nk-episode-prev');
  const next = el.querySelector('.nk-episode-next');

  if (prev instanceof HTMLAnchorElement) {
    data.episodeNav.prev = {
      title: prev.textContent?.trim() ?? '',
      url: prev.href,
    };
  }
  if (next instanceof HTMLAnchorElement) {
    data.episodeNav.next = {
      title: next.textContent?.trim() ?? '',
      url: next.href,
    };
  }

  return data;
}
