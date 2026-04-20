import { createRequire } from 'module';
import axios from 'axios';
import { logger } from './logger.js';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';

/**
 * cheerio@1.0.0-rc.12 is a CommonJS module. Using createRequire ensures reliable
 * interop under Node 16 ESM without relying on named export extraction.
 */
const require = createRequire(import.meta.url);
const cheerio = require('cheerio');

const MAX_CHARS = 5000;

/**
 * Fetch an arbitrary web page and extract its readable text body.
 * Strips <script> and <style> tags, then collapses whitespace.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function fetchUrlContent(url) {
  logger.info('fetchUrlContent.request', { url });

  const response = await axios.get(url, {
    httpsAgent: getJiraHttpsAgent(),
    timeout: 5000,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; jira-mcp-server/1.0)',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
  });

  const html = typeof response.data === 'string' ? response.data : '';
  if (!html) {
    logger.warn('fetchUrlContent.empty_response', { url });
    return null;
  }

  const $ = cheerio.load(html);
  $('script, style, noscript, iframe').remove();

  const text = ($('body').text() || $('*').text()).replace(/\s+/g, ' ').trim();

  if (!text) {
    logger.warn('fetchUrlContent.no_text', { url });
    return null;
  }

  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}...` : text;
}
