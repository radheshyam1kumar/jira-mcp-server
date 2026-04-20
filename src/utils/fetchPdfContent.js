import { createRequire } from 'module';
import axios from 'axios';
import { logger } from './logger.js';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';

/**
 * pdf-parse is a CommonJS module. Using createRequire avoids the ESM/CJS interop
 * issue where pdf-parse tries to run its own test suite on import.
 * Importing the inner lib file directly bypasses that test-runner bootstrap code.
 */
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const MAX_CHARS = 5000;

/**
 * Download a PDF from a URL and extract its text content.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function fetchPdfContent(url) {
  logger.info('fetchPdfContent.request', { url });

  const response = await axios.get(url, {
    httpsAgent: getJiraHttpsAgent(),
    responseType: 'arraybuffer',
    timeout: 5000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'jira-mcp-server/1.0',
      Accept: 'application/pdf,*/*',
    },
  });

  const buffer = Buffer.from(response.data);
  const parsed = await pdfParse(buffer);

  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) {
    logger.warn('fetchPdfContent.no_text_extracted', { url });
    return null;
  }

  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}...` : text;
}
