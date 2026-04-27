/**
 * @file Download section parser for `.nk-download-section`.
 *
 * Each row exposes a release name (typically tagged with a resolution
 * like `[720p]`) and one or more host-specific download links.
 */

/**
 * A single host-specific download link.
 *
 * @typedef {object} DownloadLink
 * @property {string} host Host label (e.g. "Mega", "Pixeldrain").
 * @property {string} url Absolute download URL.
 */

/**
 * One row inside the download table.
 *
 * @typedef {object} DownloadRow
 * @property {string} name Full row label, e.g. "HentaiTitle [720p]".
 * @property {string} resolution Detected resolution (uppercase, e.g. "720P").
 * @property {DownloadLink[]} links Hosts/URLs available for that release.
 */

/**
 * Browser-side extractor for `.nk-download-section`.
 *
 * @returns {DownloadRow[]} Parsed rows, empty when the section is absent.
 */
export function getDownloadSection() {
  const el = document.querySelector('.nk-download-section');
  if (!el) return [];

  return [...el.querySelectorAll('.nk-download-row')]
    .map((row) => {
      const name =
        row
          .querySelector('.nk-download-name')
          ?.textContent?.replace(/\s+/g, ' ')
          ?.trim() ?? '';

      const resolution =
        name.match(/\[(\d{3,4}p)\]/i)?.[1]?.toUpperCase() ?? '';

      const links = [...row.querySelectorAll('.nk-download-links a')]
        .map((a) => ({
          host: a.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          url: a instanceof HTMLAnchorElement ? a.href : '',
        }))
        .filter((entry) => entry.host && entry.url);

      return { name, resolution, links };
    })
    .filter((row) => row.name || row.links.length);
}
