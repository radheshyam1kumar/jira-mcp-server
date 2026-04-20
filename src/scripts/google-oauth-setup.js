/**
 * One-time helper: opens browser OAuth consent and prints GOOGLE_REFRESH_TOKEN for mcpServers.jira.env
 *
 * Prerequisites:
 * - Path to consumer `.cursor/mcp.json` as first CLI arg, or that file under the current working directory
 * - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in that file under mcpServers.jira.env
 * - Google Cloud Console → APIs & Services → Google Docs API enabled
 * - OAuth client type "Web application" with Authorized redirect URI matching
 *   GOOGLE_REDIRECT_URI (default: http://localhost:3000/oauth2callback)
 *
 * Run:
 *   node src/scripts/google-oauth-setup.js
 *   node src/scripts/google-oauth-setup.js /abs/path/to/.cursor/mcp.json
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { pickEnv, setRuntimeJiraEnvOverride } from '../config/env.js';
import {
  buildGoogleDocsConsentUrl,
  createUserOAuth2Client,
  DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
} from '../utils/googleOAuthDocs.js';

const explicit = process.argv[2]?.trim();
const configPath = explicit || path.join(process.cwd(), '.cursor', 'mcp.json');

if (!fs.existsSync(configPath)) {
  console.error(
    `Missing MCP config at ${configPath}. Pass the absolute path to .cursor/mcp.json as the first argument, or run from a repo that has .cursor/mcp.json.`,
  );
  process.exit(1);
}

let json;
try {
  json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Invalid JSON in ${configPath}: ${msg}`);
  process.exit(1);
}

const jiraEnv = json?.mcpServers?.jira?.env;
setRuntimeJiraEnvOverride(jiraEnv && typeof jiraEnv === 'object' ? jiraEnv : {});

const clientId = pickEnv('GOOGLE_CLIENT_ID');
const clientSecret = pickEnv('GOOGLE_CLIENT_SECRET');
const redirectUri = pickEnv('GOOGLE_REDIRECT_URI') || DEFAULT_GOOGLE_OAUTH_REDIRECT_URI;

if (!clientId || !clientSecret) {
  console.error(
    `Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET under mcpServers.jira.env in ${configPath}.`,
  );
  process.exit(1);
}

let callbackUrl;
try {
  callbackUrl = new URL(redirectUri);
} catch {
  console.error('Invalid GOOGLE_REDIRECT_URI:', redirectUri);
  process.exit(1);
}

if (callbackUrl.protocol !== 'http:' && callbackUrl.protocol !== 'https:') {
  console.error('GOOGLE_REDIRECT_URI must be http or https:', redirectUri);
  process.exit(1);
}

const port = Number(callbackUrl.port || (callbackUrl.protocol === 'https:' ? 443 : 80));
const callbackPath = callbackUrl.pathname || '/oauth2callback';

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error('Could not parse port from GOOGLE_REDIRECT_URI:', redirectUri);
  process.exit(1);
}

const oauth2Client = createUserOAuth2Client(clientId, clientSecret, redirectUri);
const authUrl = buildGoogleDocsConsentUrl(oauth2Client);

console.log('\n1) Open this URL in a browser (signed in as the Google account that can open the Docs):\n');
console.log(authUrl);
console.log('\n2) After you approve, the browser will hit the local callback and this process will exit.\n');
console.log(`   Listening on http://${callbackUrl.hostname}:${port}${callbackPath}\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (reqUrl.pathname !== callbackPath) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = reqUrl.searchParams.get('code');
  const errParam = reqUrl.searchParams.get('error');

  if (errParam) {
    res.writeHead(400);
    res.end(`<pre>OAuth error: ${errParam}</pre>`);
    console.error('OAuth error:', errParam, reqUrl.searchParams.get('error_description') || '');
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(400);
    res.end('<pre>Missing ?code=</pre>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>Success</h1><p>You can close this tab. Copy <code>GOOGLE_REFRESH_TOKEN</code> from the terminal into your injected <code>mcpServers.jira.env</code> (e.g. DB row or server stub).</p>',
    );

    if (!tokens.refresh_token) {
      console.warn(
        '\nNo refresh_token in response. Revoke this app at https://myaccount.google.com/permissions and run this script again (Google only returns refresh_token on first consent, or when using prompt=consent).\n',
      );
    }

    console.log('\n--- Add to mcpServers.jira.env (keep secret) ---\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || ''}\n`);
    console.log('---\n');

    server.close(() => process.exit(tokens.refresh_token ? 0 : 1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500);
    res.end(`<pre>Token exchange failed: ${msg}</pre>`);
    console.error('getToken failed:', msg);
    server.close(() => process.exit(1));
  }
});

server.listen(port, callbackUrl.hostname, () => {});

server.on('error', (err) => {
  console.error('HTTP server error:', err.message);
  process.exit(1);
});
