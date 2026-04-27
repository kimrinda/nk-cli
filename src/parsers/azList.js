/**
 * @file Parser for the `/category/hentai-list` A–Z index page.
 *
 * The index renders one `<div class="nk-az-group">` per letter
 * (`#ABC`, `A`, `B`, …, `Z`). Each group contains anchor tags whose
 * `original-title` / `data-original-title` / `title` attribute carries
 * an HTML snippet describing the title (the tooltip card).
 *
 * The exported function runs **inside the page context** via
 * `page.evaluate(...)` and must remain self-contained.
 */

/**
 * Tooltip card extracted from an `original-title` HTML payload.
 *
 * @typedef {object} TooltipCard
 * @property {string} title Trimmed title text.
 * @property {string} image Cover image URL.
 * @property {string} japaneseName "Nama Jepang" field.
 * @property {string[]} producers "Produser" / "Producer" list.
 * @property {string} type "Tipe" field.
 * @property {string} status "Status" field.
 * @property {string[]} genre "Genre" list.
 * @property {string} duration "Durasi" / "Duration" field.
 * @property {string} score "Skor" / "Score" field.
 */

/**
 * Single anchor entry inside an A–Z group.
 *
 * @typedef {object} AzItem
 * @property {string} id `rel` attribute on the anchor (post ID).
 * @property {string} title Anchor text.
 * @property {string} slug Last URL segment of `href`.
 * @property {string} url Absolute URL.
 * @property {TooltipCard | null} tooltip Parsed tooltip card (may be null when payload missing/unparseable).
 */

/**
 * Group of anchors keyed by their letter index.
 *
 * @typedef {object} AzGroup
 * @property {string} index Letter index (e.g. `A`, `#ABC`).
 * @property {number} count Number of items in the group.
 * @property {AzItem[]} items Anchor entries in the group.
 */

/**
 * Browser-side extractor for the A–Z index page.
 *
 * Adaptation of the user-supplied `parseAzList` reference implementation;
 * the helper functions are inlined so Puppeteer can serialise this with
 * `Function.prototype.toString` and execute it in the page context.
 *
 * @returns {Record<string, AzGroup>} Groups keyed by letter index.
 */
export function parseAzList() {
  /**
   * Collapse whitespace and trim the supplied value.
   *
   * @param {string | null | undefined} value Raw textual value.
   * @returns {string} Cleaned value (empty string for nullish input).
   */
  function textClean(value) {
    return (value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract the slug (last path segment) from an absolute URL.
   *
   * @param {string} url URL to dissect.
   * @returns {string} Slug.
   */
  function slugFromUrl(url) {
    return (url || '').replace(/\/$/, '').split('/').pop() || '';
  }

  /**
   * Parse the HTML payload stored on `original-title`/`title` into a
   * structured tooltip card.
   *
   * @param {string} html Raw HTML payload.
   * @returns {TooltipCard | null} Structured card or null on failure.
   */
  function parseTooltipCard(html) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const card = doc.querySelector('.nk-tooltip-card');
    if (!card) return null;

    const detailEl = card.querySelector('.nk-tooltip-detail');
    const detailText = textClean(detailEl ? detailEl.textContent : '');

    /**
     * Pull a label-prefixed field out of the flattened tooltip text.
     *
     * @param {string} label Label regex source (alternation OK).
     * @returns {string} Cleaned value (empty when missing).
     */
    function getField(label) {
      // The label argument may itself be an alternation (e.g.
      // "Produser|Producer"), so it must be wrapped in a non-capturing
      // group — otherwise JS regex precedence would let the bare
      // "Produser" match alone and the value capture group would be
      // undefined.
      const match = detailText.match(
        new RegExp(
          `(?:${label})\\s*:\\s*(.*?)(?=\\s*(?:Nama Jepang|Produser|Producer|Tipe|Status|Genre|Durasi|Duration|Skor|Score)\\s*:|$)`,
          'i',
        ),
      );
      return textClean(match ? match[1] : '');
    }

    const producersField = getField('Produser|Producer');
    const genreField = getField('Genre');

    const imgEl = card.querySelector('img');
    const titleEl = card.querySelector('h2');

    return {
      title: textClean(titleEl ? titleEl.textContent : ''),
      image: imgEl ? imgEl.getAttribute('src') || '' : '',
      japaneseName: getField('Nama Jepang'),
      producers: producersField
        ? producersField.split(',').map(textClean).filter(Boolean)
        : [],
      type: getField('Tipe'),
      status: getField('Status'),
      genre: genreField
        ? genreField.split(',').map(textClean).filter(Boolean)
        : [],
      duration: getField('Durasi|Duration'),
      score: getField('Skor|Score'),
    };
  }

  const root = document.querySelector('#nk-az-list');
  if (!root) return {};

  /** @type {Record<string, AzGroup>} */
  const result = {};

  for (const group of root.querySelectorAll('.nk-az-group')) {
    const letterAnchor = group.querySelector('.nk-az-letter a');
    const letterText = group.querySelector('.nk-az-letter');
    const index = textClean(
      (letterAnchor ? letterAnchor.getAttribute('name') : '') ||
        (letterText ? letterText.textContent : ''),
    );

    /** @type {AzItem[]} */
    const items = [];
    for (const a of group.querySelectorAll('.nk-az-item a')) {
      const url =
        /** @type {HTMLAnchorElement} */ (a).href ||
        a.getAttribute('href') ||
        '';
      const tooltipHtml =
        a.getAttribute('original-title') ||
        a.getAttribute('data-original-title') ||
        a.getAttribute('title') ||
        '';
      items.push({
        id: a.getAttribute('rel') || '',
        title: textClean(a.textContent),
        slug: slugFromUrl(url),
        url,
        tooltip: parseTooltipCard(tooltipHtml),
      });
    }

    if (index) {
      result[index] = { index, count: items.length, items };
    }
  }

  return result;
}
