/**
 * @file Detail-page content body parser.
 *
 * Extracts the structured metadata block that lives inside `.konten`,
 * plus the post header (title, views, uploaded date).
 */

/**
 * Structured representation of a detail page's content body.
 *
 * @typedef {object} ContentBody
 * @property {string} title Post title from `.nk-post-header > h1`.
 * @property {string} synopsis Long-form description, when present.
 * @property {string[]} genre Genre tags parsed from the `Genre:` row.
 * @property {string[]} producers Producer credits parsed from the row.
 * @property {string} duration Duration text (e.g. "24 min").
 * @property {Record<string, string>} size Map from resolution to size string.
 * @property {string} note Optional free-form note ("Catatan").
 * @property {string} views Total views string, when surfaced in the header.
 * @property {string} uploaded Upload date string, when surfaced in the header.
 */

/**
 * Browser-side extractor for the `.konten` body and its surrounding header.
 *
 * @returns {ContentBody} Parsed content body. Empty fields when not present.
 */
export function getContentBody() {
  /** @type {ContentBody} */
  const data = {
    title: '',
    synopsis: '',
    genre: [],
    producers: [],
    duration: '',
    size: {},
    note: '',
    views: '',
    uploaded: '',
  };

  const el = document.querySelector('.konten');
  if (el) {
    const rows = [...el.querySelectorAll('p,h1,h2,h3,h4,h5,h6')]
      .map((node) =>
        (node.textContent ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean);

    for (const row of rows) {
      const lower = row.toLowerCase();

      if (/^(judul|title)\s*:/.test(lower)) {
        data.title = row.replace(/^(judul|title)\s*:/i, '').trim();
        continue;
      }

      if (/^sinopsis/.test(lower)) continue;

      if (
        !data.synopsis &&
        row.length > 80 &&
        !/^(genre|producer|producers|duration|durasi|ukuran|size|catatan|judul)/i.test(
          row,
        )
      ) {
        data.synopsis = row.trim();
        continue;
      }

      if (/^(producer|producers)\s*:/.test(lower)) {
        data.producers = row
          .replace(/^(producer|producers)\s*:/i, '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        continue;
      }

      if (/^genre\s*:/.test(lower)) {
        data.genre = row
          .replace(/^genre\s*:/i, '')
          .replace(/\.$/, '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        continue;
      }

      if (/^(duration|durasi)\s*:/.test(lower)) {
        data.duration = row.replace(/^(duration|durasi)\s*:/i, '').trim();
        continue;
      }

      if (/^(size|ukuran)\s*:/.test(lower)) {
        const clean = row.replace(/^(size|ukuran)\s*:/i, '').trim();
        const matches = [
          ...clean.matchAll(/(\d{3,4}P)\s*:\s*([\d.,]+\s*[a-z]+)/gi),
        ];
        matches.forEach((m) => {
          data.size[m[1].toUpperCase()] = m[2].trim();
        });
        continue;
      }

      if (/^catatan\s*:/.test(lower)) {
        data.note = row.replace(/^catatan\s*:/i, '').trim();
      }
    }
  }

  const headerTitle = document
    .querySelector('.nk-post-header > h1')
    ?.textContent?.trim();
  if (headerTitle) data.title = headerTitle;

  const headerMeta = document.querySelector('.nk-post-header-meta');
  if (headerMeta) {
    const visibility = headerMeta.querySelector('span[class*="visibility"]');
    if (visibility?.nextSibling?.textContent) {
      data.views = visibility.nextSibling.textContent.trim();
    }

    const calendar = headerMeta.querySelector('span[class*="calendar"]');
    if (calendar?.nextSibling?.textContent) {
      data.uploaded = calendar.nextSibling.textContent.trim();
    }
  }

  return data;
}
