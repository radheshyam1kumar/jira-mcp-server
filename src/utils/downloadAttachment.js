import { formatHttpError, getJiraHttp } from './jiraHttp.js';
import { isJiraTlsInsecureMode } from './jiraHttpsAgent.js';
import { logger } from './logger.js';

function certificateHint(message) {
  if (!/certificate|issuer|TLS|SSL|UNABLE_TO_GET_ISSUER/i.test(message) || isJiraTlsInsecureMode()) {
    return '';
  }
  return (
    ' Fix: set JIRA_EXTRA_CA_FILE to a PEM bundle for your corporate CA (merged with system roots), ' +
    'or set NODE_EXTRA_CA_CERTS to the same PEM. Dev only: JIRA_TLS_INSECURE=true in injected mcpServers.jira.env.'
  );
}

export async function downloadAttachment(url, { authorization }) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'Invalid URL' };
  }
  if (!authorization || typeof authorization !== 'string') {
    return { ok: false, error: 'Missing Authorization header' };
  }

  const headers = {
    Authorization: authorization,
    Accept: '*/*',
    'User-Agent': 'jira-mcp-server/1.0 (Node.js; Jira attachment fetch)',
  };

  try {
    const response = await getJiraHttp().get(url, {
      headers,
      responseType: 'arraybuffer',
    });

    const status = response.status;

    if (status === 401) {
      logger.error('jira.attachment.unauthorized', { url: truncateUrl(url) });
      return { ok: false, error: 'Unauthorized (401) — check JIRA_EMAIL and JIRA_API_TOKEN.', status: 401 };
    }
    if (status === 403) {
      logger.error('jira.attachment.forbidden', { url: truncateUrl(url), status: 403 });
      return { ok: false, error: 'Forbidden (403) — missing attachment permission.', status: 403 };
    }
    if (status < 200 || status >= 300) {
      logger.warn('jira.attachment.http_error', { url: truncateUrl(url), status });
      return { ok: false, error: `HTTP ${status}`, status };
    }

    const buffer = Buffer.from(response.data);
    return { ok: true, buffer };
  } catch (err) {
    const message = formatHttpError(err);
    logger.error('jira.attachment.network', { url: truncateUrl(url), message });
    return { ok: false, error: message + certificateHint(message) };
  }
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}
