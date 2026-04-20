/**
 * Finds an s3:// object URL in Jenkins console output (AWS CLI and similar).
 *
 * Order of preference (later beats earlier within each group):
 * 1. Lines like `upload: <local> to s3://bucket/key` (s3 sync / cp output)
 * 2. Lines containing `aws s3 cp|mv|sync` — uses the last s3:// URL on that line (destination when mixed with local paths)
 * 3. Any remaining `s3://bucket/…` with a non-empty object key — last in the log
 *
 * Does not require a filename extension; keys can be arbitrary (e.g. `release-v99`, `artifact`).
 *
 * @param {string} logText
 * @returns {string} Full s3:// URI or empty string
 */
export function extractS3ArtifactPathFromLog(logText) {
  if (!logText || typeof logText !== 'string') return '';

  const cleanUrl = (u) => String(u).replace(/[),\];>]+$/g, '');

  /** s3://bucket/<non-empty key> */
  const hasObjectKey = (u) => /^s3:\/\/[^/]+\/\S/i.test(u);

  const candidates = [];

  for (const m of logText.matchAll(/\bupload:\s[^\n]+?\s+to\s+(s3:\/\/[^\s'"<>|,)]+)/gi)) {
    const u = cleanUrl(m[1]);
    if (hasObjectKey(u)) candidates.push(u);
  }

  for (const line of logText.split('\n')) {
    if (!/\baws\s+s3\s+(cp|mv|sync)\b/i.test(line)) continue;
    const urls = [...line.matchAll(/\bs3:\/\/[^\s'"<>|,)]+/gi)]
      .map((x) => cleanUrl(x[0]))
      .filter(hasObjectKey);
    if (urls.length) candidates.push(urls[urls.length - 1]);
  }

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  const generic = [...logText.matchAll(/\bs3:\/\/[^\s'"<>|]+/gi)]
    .map((m) => cleanUrl(m[0]))
    .filter(hasObjectKey);

  return generic.length > 0 ? generic[generic.length - 1] : '';
}
