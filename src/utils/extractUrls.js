/**
 * URL extraction utilities for Jira issue fields.
 * Handles both plain-text regex extraction and Atlassian Document Format (ADF) traversal.
 */

const URL_REGEX = /https?:\/\/[^\s<>"')\]\\]+/g;

const MAX_URLS = 5;

/** File extensions and patterns that indicate non-content links to skip */
const SKIP_PATTERNS = [
  /\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?)(\?[^#]*)?$/i,
  /\.(mp4|mov|avi|mkv|webm|mp3|wav|ogg)(\?[^#]*)?$/i,
  /[?&]utm_/i,
  /\/track(ing)?\//i,
  /pixel\.(gif|png)/i,
];

function shouldSkipUrl(url) {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

/**
 * Extract URLs from plain text using regex.
 */
export function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(URL_REGEX) || [];
  return matches.map((u) => u.replace(/[.,;:!?)]+$/, ''));
}

/**
 * Traverse an Atlassian Document Format (ADF) node tree and collect all URLs from:
 * - inlineCard / blockCard nodes (pasted URLs in Jira)
 * - text nodes with a "link" mark (hyperlinks)
 */
export function extractUrlsFromAdf(node) {
  const urls = [];

  function traverse(n) {
    if (!n || typeof n !== 'object') return;

    if (
      (n.type === 'inlineCard' || n.type === 'blockCard') &&
      n.attrs &&
      typeof n.attrs.url === 'string'
    ) {
      urls.push(n.attrs.url);
    }

    if (n.type === 'text' && Array.isArray(n.marks)) {
      for (const mark of n.marks) {
        if (mark.type === 'link' && mark.attrs && typeof mark.attrs.href === 'string') {
          urls.push(mark.attrs.href);
        }
      }
    }

    if (Array.isArray(n.content)) {
      for (const child of n.content) {
        traverse(child);
      }
    }
  }

  traverse(node);
  return urls;
}

/**
 * Combine URLs from ADF and plain text, deduplicate, filter noise, cap at MAX_URLS.
 *
 * @param {string} descriptionText  - Already-extracted plain text description
 * @param {object|null} descriptionAdf - Raw ADF object (or null)
 * @returns {string[]}
 */
export function extractAndFilterUrls(descriptionText, descriptionAdf) {
  const seen = new Set();
  const result = [];

  function addIfNew(url) {
    if (!url || seen.has(url) || shouldSkipUrl(url)) return;
    seen.add(url);
    result.push(url);
  }

  // ADF link marks are more intentional — process them first
  for (const url of extractUrlsFromAdf(descriptionAdf)) {
    addIfNew(url);
  }

  // Plain-text URLs (pastes, etc.)
  for (const url of extractUrlsFromText(descriptionText)) {
    addIfNew(url);
  }

  return result.slice(0, MAX_URLS);
}
