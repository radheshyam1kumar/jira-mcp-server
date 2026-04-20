import axios from 'axios';
import { pickEnv } from '../config/env.js';
import { logger } from './logger.js';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';

/**
 * Extract the numeric page ID from a Confluence URL.
 * Handles formats:
 *   - /wiki/spaces/SPACE/pages/12345/...
 *   - /wiki/display/SPACE/...  (no page ID — falls through to null)
 */
function extractPageId(url) {
  const match = url.match(/\/pages\/(?:view\/)?(\d+)/);
  return match ? match[1] : null;
}

/**
 * Build the Confluence base URL (scheme + host), which is the same host as Jira.
 */
function extractBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function buildBasicAuthHeader() {
  const email = pickEnv('JIRA_EMAIL');
  const token = pickEnv('JIRA_API_TOKEN');
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

/**
 * Fetch and return the HTML body of a Confluence page via its REST API.
 *
 * @param {string} url  Full Confluence page URL
 * @returns {Promise<string|null>}  HTML content string, or null if unable to fetch
 */
export async function fetchConfluenceContent(url) {
  const pageId = extractPageId(url);
  if (!pageId) {
    logger.warn('fetchConfluenceContent.no_page_id', { url });
    return null;
  }

  const baseUrl = extractBaseUrl(url);
  if (!baseUrl) {
    logger.warn('fetchConfluenceContent.invalid_url', { url });
    return null;
  }

  const apiUrl = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.view`;
  logger.info('fetchConfluenceContent.request', { apiUrl });

  const response = await axios.get(apiUrl, {
    httpsAgent: getJiraHttpsAgent(),
    headers: {
      Authorization: buildBasicAuthHeader(),
      Accept: 'application/json',
    },
    timeout: 5000,
    maxRedirects: 5,
  });

  const html = response.data?.body?.view?.value;
  if (!html || typeof html !== 'string') {
    logger.warn('fetchConfluenceContent.empty_body', { url, pageId });
    return null;
  }

  return html;
}
