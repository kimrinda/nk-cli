/**
 * @file Browser-side featured-image srcset parser.
 *
 * Extracts the responsive image sources from the `.nk-featured-img img`
 * element's `srcset` attribute, returning a structured object with the
 * raw `src`, the largest and smallest variants, and the full sorted
 * source list.
 *
 * Designed to run inside `page.evaluate()` — no Node-only APIs.
 */

/**
 * A single width-descriptor source parsed from a `srcset` attribute.
 *
 * @typedef {object} ImageSource
 * @property {string} url Absolute URL of the image variant.
 * @property {number} width Intrinsic width in pixels (the `w` descriptor).
 */

/**
 * Structured featured-image data extracted from `.nk-featured-img img`.
 *
 * @typedef {object} FeaturedImageData
 * @property {string} src Value of the `src` attribute.
 * @property {string} currentSrc Browser-resolved current source.
 * @property {string} largest URL of the widest variant (or `src` fallback).
 * @property {string} smallest URL of the narrowest variant (or `src` fallback).
 * @property {ImageSource[]} sources Sorted (ascending width) source list.
 */

/**
 * Parse the `srcset` attribute of `.nk-featured-img img` and return a
 * structured {@link FeaturedImageData} object.
 *
 * @returns {FeaturedImageData | null} Image data or `null` when the
 *   element is not found.
 */
export function parseFeaturedImage() {
  const img = document.querySelector(".nk-featured-img img");
  if (!img) return null;

  const srcset = img.getAttribute("srcset") || "";
  const src = img.getAttribute("src") || "";
  const currentSrc = /** @type {HTMLImageElement} */ (img).currentSrc || src;

  const sources = srcset
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(https?:\/\/\S+)\s+(\d+)w$/i);
      if (!match) return null;
      return { url: match[1], width: Number(match[2]) };
    })
    .filter(Boolean)
    .sort((a, b) => a.width - b.width);

  return {
    src,
    currentSrc,
    largest: sources.length ? sources[sources.length - 1].url : src,
    smallest: sources.length ? sources[0].url : src,
    sources,
  };
}
