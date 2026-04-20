/**
 * Classify a URL into one of the supported content types.
 *
 * @param {string} url
 * @returns {"confluence"|"google-doc"|"pdf"|"web"}
 */
export function detectUrlType(url) {
  if (!url || typeof url !== 'string') return 'web';

  if (/atlassian\.net\/wiki/i.test(url)) return 'confluence';
  if (/docs\.google\.com\/document/i.test(url)) return 'google-doc';
  if (/\.pdf(\?[^#]*)?$/i.test(url)) return 'pdf';

  return 'web';
}
