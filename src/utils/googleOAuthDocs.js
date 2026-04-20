import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { pickEnv } from '../config/env.js';
import { extractTextFromDocumentContent } from './googleDocsPlainText.js';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';
import { logger } from './logger.js';

export const GOOGLE_DOCS_READONLY_SCOPE = 'https://www.googleapis.com/auth/documents.readonly';

/** Default redirect for `npm run google-oauth-init` — must match Google Cloud Console → OAuth client → Authorized redirect URIs exactly. */
export const DEFAULT_GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/oauth2callback';

/**
 * @returns {{ clientId: string, clientSecret: string, refreshToken: string, redirectUri: string } | null}
 */
export function getGoogleUserOAuthEnv() {
  const clientId = pickEnv('GOOGLE_CLIENT_ID');
  const clientSecret = pickEnv('GOOGLE_CLIENT_SECRET');
  const refreshToken = pickEnv('GOOGLE_REFRESH_TOKEN');
  const redirectUri = pickEnv('GOOGLE_REDIRECT_URI') || DEFAULT_GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return { clientId, clientSecret, refreshToken, redirectUri };
}

/**
 * OAuth2 client with the same HTTPS agent as Jira (corporate TLS / extra CA).
 */
export function createUserOAuth2Client(clientId, clientSecret, redirectUri) {
  const agent = getJiraHttpsAgent();
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    transporterOptions: {
      agent,
    },
  });
}

/**
 * Fetch document body as plain text using a **user** OAuth refresh token.
 * The signed-in user must have access to the doc (same as in the browser).
 *
 * @param {string} documentId
 * @returns {Promise<string|null>}
 */
export async function fetchGoogleDocViaUserOAuth(documentId) {
  const env = getGoogleUserOAuthEnv();
  if (!env) {
    return null;
  }

  const { clientId, clientSecret, refreshToken, redirectUri } = env;
  const oauth2Client = createUserOAuth2Client(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  await oauth2Client.getAccessToken();

  const docs = google.docs({ version: 'v1', auth: oauth2Client });
  logger.info('fetchGoogleDoc.via_user_oauth', { documentId });

  const res = await docs.documents.get({ documentId });
  const body = res.data?.body?.content;
  const raw = extractTextFromDocumentContent(body).replace(/\n{3,}/g, '\n\n').trim();
  return raw || null;
}

/** @param {import('google-auth-library').OAuth2Client} oauth2Client */
export function buildGoogleDocsConsentUrl(oauth2Client) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GOOGLE_DOCS_READONLY_SCOPE],
  });
}
