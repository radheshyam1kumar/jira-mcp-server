import axios from 'axios';
import { extractGoogleDocId } from './googleDocsPlainText.js';
import { fetchGoogleDocViaUserOAuth, getGoogleUserOAuthEnv } from './googleOAuthDocs.js';
import { logger } from './logger.js';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';

/**
 * Convert a Google Docs viewer/edit URL into a plain-text export URL.
 *
 * @param {string} docId
 * @returns {string}
 */
function toExportUrlForDocId(docId) {
  return `https://docs.google.com/document/d/${docId}/export?format=txt`;
}

/**
 * Anonymous export (works when the doc is shared with “Anyone with the link”).
 *
 * @param {string} docId
 * @param {string} originalUrl
 * @returns {Promise<string|null>}
 */
async function fetchGoogleDocViaExport(docId, originalUrl) {
  const exportUrl = toExportUrlForDocId(docId);
  logger.info('fetchGoogleDoc.via_export', { exportUrl });

  const response = await axios.get(exportUrl, {
    httpsAgent: getJiraHttpsAgent(),
    timeout: 5000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: () => true,
    headers: {
      'User-Agent': 'jira-mcp-server/1.0',
    },
  });

  if (response.status < 200 || response.status >= 300) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' — use user OAuth (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN from npm run google-oauth-init) or share the doc with “Anyone with the link”'
        : '';
    logger.warn('fetchGoogleDoc.http_error', { exportUrl, status: response.status });
    throw new Error(`Google Doc export HTTP ${response.status}${hint}`);
  }

  const text = typeof response.data === 'string' ? response.data.trim() : null;
  if (!text) {
    logger.warn('fetchGoogleDoc.empty_response', { url: originalUrl });
    return null;
  }

  return text;
}

/**
 * Fetch a Google Doc as plain text.
 *
 * 1) If `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` are set,
 *    uses the Google Docs API as the signed-in user (docs you can open in the browser).
 * 2) Otherwise tries the public export URL.
 *
 * @param {string} url  Google Docs URL
 * @returns {Promise<string|null>}
 */
export async function fetchGoogleDoc(url) {
  const docId = extractGoogleDocId(url);
  if (!docId) {
    logger.warn('fetchGoogleDoc.no_doc_id', { url });
    return null;
  }

  /** @type {Error|undefined} */
  let oauthError;

  if (getGoogleUserOAuthEnv()) {
    try {
      const text = await fetchGoogleDocViaUserOAuth(docId);
      if (text) {
        return text;
      }
      logger.warn('fetchGoogleDoc.oauth_empty_falling_back_export', { documentId: docId });
    } catch (err) {
      oauthError = err instanceof Error ? err : new Error(String(err));
      logger.warn('fetchGoogleDoc.oauth_failed_falling_back_export', {
        documentId: docId,
        message: oauthError.message,
      });
    }
  }

  try {
    return await fetchGoogleDocViaExport(docId, url);
  } catch (exportErr) {
    const exportMessage = exportErr instanceof Error ? exportErr.message : String(exportErr);
    if (oauthError) {
      throw new Error(`${exportMessage} | Google user OAuth: ${oauthError.message}`);
    }
    throw exportErr instanceof Error ? exportErr : new Error(exportMessage);
  }
}
