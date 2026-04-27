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
  const el = document.querySelector(".konten");

  const data = {};

  const cleanText = (value) =>
    (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const splitList = (value) =>
    cleanText(value)
      .replace(/\.$/, "")
      .split(",")
      .map((v) => cleanText(v))
      .filter(Boolean);

  const setIfValue = (key, value) => {
    if (Array.isArray(value)) {
      if (value.length) data[key] = value;
      return;
    }

    if (value && Object.keys(value).length !== 0) {
      data[key] = value;
    }
  };

  const parseSize = (row) => {
    const result = {};

    const matches = [
      ...row.matchAll(/(\d{3,4}\s*P)\s*:\s*([\d.,]+\s*[a-z]+)/gi),
    ];

    matches.forEach((m) => {
      const key = m[1].replace(/\s+/g, "").toUpperCase();
      result[key] = cleanText(m[2]);
    });

    return result;
  };

  const rows = [...el.querySelectorAll("p,h1,h2,h3,h4,h5,h6")]
    .map((node) => cleanText(node.textContent))
    .filter(Boolean);

  for (const row of rows) {
    const lower = row.toLowerCase();

    // title
    if (/^(judul|title)\s*:/.test(lower)) {
      setIfValue("title", row.replace(/^(judul|title)\s*:/i, ""));
      continue;
    }

    // original title (support space before colon)
    if (/^original title\s*:/.test(lower)) {
      setIfValue("originalTitle", row.replace(/^original title\s*:/i, ""));
      continue;
    }

    // nuclear code
    if (/^nuclear code\s*:/.test(lower)) {
      setIfValue("nuclearCode", row.replace(/^nuclear code\s*:/i, ""));
      continue;
    }

    // parody
    if (/^parody\s*:/.test(lower)) {
      setIfValue("parody", splitList(row.replace(/^parody\s*:/i, "")));
      continue;
    }

    // actress
    if (/^(actress|actor|actors)\s*:/.test(lower)) {
      setIfValue(
        "actress",
        splitList(row.replace(/^(actress|actor|actors)\s*:/i, "")),
      );
      continue;
    }

    // skip sinopsis label
    if (/^sinopsis/.test(lower)) {
      continue;
    }

    // auto synopsis
    if (
      !data.synopsis &&
      row.length > 80 &&
      !/^(genre|producer|producers|produser|duration|durasi|ukuran|size|catatan|judul|title|original title|nuclear code|actress|actor|actors|parody)\s*:/i.test(
        row,
      )
    ) {
      setIfValue("synopsis", row);
      continue;
    }

    // producers
    if (/^(producer|producers|produser)\s*:/.test(lower)) {
      setIfValue(
        "producers",
        splitList(row.replace(/^(producer|producers|produser)\s*:/i, "")),
      );
      continue;
    }

    // genre
    if (/^genre\s*:/.test(lower)) {
      setIfValue("genre", splitList(row.replace(/^genre\s*:/i, "")));
      continue;
    }

    // duration
    if (/^(duration|durasi)\s*:/.test(lower)) {
      setIfValue("duration", row.replace(/^(duration|durasi)\s*:/i, ""));
      continue;
    }

    // size
    if (/^(size|ukuran)\s*:/.test(lower)) {
      setIfValue("size", parseSize(row));
      continue;
    }

    // note
    if (/^catatan\s*:/.test(lower)) {
      setIfValue("note", row.replace(/^catatan\s*:/i, ""));
      continue;
    }
  }

  // fallback title from page header
  const pageTitle = cleanText(
    document.querySelector(".nk-post-header > h1")?.textContent,
  );

  if (pageTitle) data.title = pageTitle;

  const views = cleanText(
    document
      .querySelector(".nk-post-header-meta")
      ?.querySelector('span[class*="visibility"]')?.nextSibling?.textContent,
  );

  const uploaded = cleanText(
    document
      .querySelector(".nk-post-header-meta")
      ?.querySelector('span[class*="calendar"]')?.nextSibling?.textContent,
  );

  if (views) data.views = views;
  if (uploaded) data.uploaded = uploaded;

  return data;
}
