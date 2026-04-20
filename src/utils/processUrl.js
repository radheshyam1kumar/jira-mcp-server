import { detectUrlType } from './detectUrlType.js';
import { fetchConfluenceContent } from './fetchConfluenceContent.js';
import { fetchGoogleDoc } from './fetchGoogleDoc.js';
import { fetchPdfContent } from './fetchPdfContent.js';
import { fetchUrlContent } from './fetchUrlContent.js';
import { logger } from './logger.js';

/**
 * Fetch content for a single URL and return a structured result.
 *
 * @param {string} url
 * @returns {Promise<{ url: string, type: string, content?: string, error?: string }>}
 */
export async function processUrl(url) {
  const type = detectUrlType(url);

  logger.info('processUrl.start', { url, type });

  try {
    let content;

    switch (type) {
      case 'confluence':
        content = await fetchConfluenceContent(url);
        break;
      case 'google-doc':
        content = await fetchGoogleDoc(url);
        break;
      case 'pdf':
        content = await fetchPdfContent(url);
        break;
      default:
        content = await fetchUrlContent(url);
    }

    if (!content) {
      logger.warn('processUrl.no_content', { url, type });
      return { url, type, error: 'No content returned' };
    }

    logger.info('processUrl.success', { url, type, chars: content.length });
    return { url, type, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('processUrl.failed', { url, type, message });
    const safe = message.length > 500 ? `${message.slice(0, 500)}…` : message;
    return { url, type, error: safe || 'Failed to fetch content' };
  }
}
