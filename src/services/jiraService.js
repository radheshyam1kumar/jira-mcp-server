import { buildBasicAuthHeader } from '../utils/auth.js';
import { downloadAttachment } from '../utils/downloadAttachment.js';
import { formatHttpError, getJiraHttp } from '../utils/jiraHttp.js';
import { logger } from '../utils/logger.js';
import { extractAndFilterUrls } from '../utils/extractUrls.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

function isAllowedImageMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  const base = mime.split(';')[0].trim().toLowerCase();
  return IMAGE_MIME_TYPES.has(base);
}

export function mapIssueAttachments(fields) {
  const raw = fields && typeof fields === 'object' && Array.isArray(fields.attachment) ? fields.attachment : [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const fileName = typeof a.filename === 'string' ? a.filename : '';
    const mimeType = typeof a.mimeType === 'string' ? a.mimeType : '';
    const url = typeof a.content === 'string' ? a.content : '';
    if (!fileName || !url) continue;
    out.push({
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      url,
    });
  }
  return out;
}

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export class JiraServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JiraServiceError';
    this.code = code;
    this.details = details;
  }

  toAiPayload() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function extractTextFromAdf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }

  const parts = [];
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      parts.push(extractTextFromAdf(child));
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function validateIssueKey(issueKey) {
  const key = typeof issueKey === 'string' ? issueKey.trim() : '';
  if (!key) {
    throw new JiraServiceError('INVALID_KEY', 'Issue key is required.', { issueKey: issueKey ?? null });
  }
  if (!ISSUE_KEY_PATTERN.test(key)) {
    throw new JiraServiceError(
      'INVALID_KEY',
      `Invalid Jira issue key format: "${key}". Expected something like IPG-754.`,
      { issueKey: key },
    );
  }
  return key.toUpperCase();
}

export function createJiraService(config) {
  const authHeader = buildBasicAuthHeader(config.jiraEmail, config.jiraApiToken);

  async function diagnoseForbidden(issueKey) {
    const headers = {
      Authorization: authHeader,
      Accept: 'application/json',
    };
    const myselfUrl = `${config.jiraBaseUrl}/rest/api/3/myself`;
    const searchUrl = `${config.jiraBaseUrl}/rest/api/3/search`;
    const result = {
      myselfStatus: null,
      searchStatus: null,
      searchTotal: null,
      reason: null,
    };

    try {
      const me = await getJiraHttp().get(myselfUrl, {
        headers,
        responseType: 'text',
        transformResponse: [(data) => data],
      });
      result.myselfStatus = me.status;
      if (me.status === 401) {
        result.reason = 'auth_failed';
        return result;
      }
    } catch {
      result.reason = 'network_error';
      return result;
    }

    try {
      const search = await getJiraHttp().get(searchUrl, {
        headers,
        params: {
          jql: `key = "${issueKey}"`,
          maxResults: 1,
          fields: 'summary,status',
        },
        responseType: 'text',
        transformResponse: [(data) => data],
      });
      result.searchStatus = search.status;
      let bodyJson = null;
      if (typeof search.data === 'string' && search.data) {
        try {
          bodyJson = JSON.parse(search.data);
        } catch {
          bodyJson = null;
        }
      }
      result.searchTotal =
        bodyJson && typeof bodyJson === 'object' && Number.isInteger(bodyJson.total) ? bodyJson.total : null;
      if (search.status === 401) {
        result.reason = 'auth_failed';
      } else if (search.status === 403) {
        result.reason = 'project_or_issue_permission_denied';
      } else if (search.status >= 200 && search.status < 300 && result.searchTotal === 0) {
        result.reason = 'issue_not_visible_or_not_found';
      } else {
        result.reason = 'issue_permission_denied';
      }
      return result;
    } catch {
      result.reason = 'network_error';
      return result;
    }
  }

  async function getIssue(issueKeyRaw) {
    const issueKey = validateIssueKey(issueKeyRaw);
    const url = `${config.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;

    logger.jiraRequest('GET', url);

    let response;
    try {
      response = await getJiraHttp().get(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
        responseType: 'text',
        transformResponse: [(data) => data],
      });
    } catch (err) {
      const cause = formatHttpError(err);
      logger.error('jira.network_failure', { url, cause });
      throw new JiraServiceError(
        'NETWORK_ERROR',
        'Could not reach Jira. Check network connectivity and JIRA_DOMAIN.',
        { cause },
      );
    }

    const bodyText = typeof response.data === 'string' ? response.data : '';

    let bodyJson = null;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }
    }

    const httpStatus = response.status;

    if (httpStatus === 401) {
      logger.error('jira.auth_failed', { url, status: httpStatus });
      throw new JiraServiceError(
        'UNAUTHORIZED',
        'Jira authentication failed. Verify JIRA_EMAIL and JIRA_API_TOKEN.',
        { status: httpStatus },
      );
    }

    if (httpStatus === 403) {
      const diag = await diagnoseForbidden(issueKey);
      logger.error('jira.forbidden', { url, status: httpStatus, diagnostics: diag });
      if (diag.reason === 'auth_failed') {
        throw new JiraServiceError(
          'UNAUTHORIZED',
          'Jira authentication failed for this domain. Verify JIRA_DOMAIN, JIRA_EMAIL, and JIRA_API_TOKEN.',
          { status: httpStatus, jira: bodyJson, diagnostics: diag },
        );
      }
      throw new JiraServiceError(
        'FORBIDDEN',
        'Jira returned 403. Credentials are accepted, but this user cannot access the issue (Browse Projects / issue security).',
        { status: httpStatus, jira: bodyJson, diagnostics: diag },
      );
    }

    if (httpStatus === 404) {
      logger.warn('jira.issue_not_found', { url, status: httpStatus });
      throw new JiraServiceError(
        'ISSUE_NOT_FOUND',
        `No Jira issue found for key "${issueKey}".`,
        { status: httpStatus, issueKey, jira: bodyJson },
      );
    }

    if (httpStatus === 429) {
      throw new JiraServiceError('RATE_LIMITED', 'Jira rate limit exceeded. Retry later.', {
        status: httpStatus,
        jira: bodyJson,
      });
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      logger.error('jira.unexpected_status', { url, status: httpStatus });
      throw new JiraServiceError(
        'JIRA_API_ERROR',
        `Jira API error (${httpStatus}).`,
        { status: httpStatus, jira: bodyJson },
      );
    }

    if (!bodyJson || typeof bodyJson !== 'object') {
      throw new JiraServiceError('INVALID_RESPONSE', 'Unexpected empty or non-JSON response from Jira.', {});
    }

    const fields = bodyJson.fields && typeof bodyJson.fields === 'object' ? bodyJson.fields : {};
    const summary = typeof fields.summary === 'string' ? fields.summary : '';
    const descriptionField = fields.description;
    const description =
      typeof descriptionField === 'string'
        ? descriptionField
        : extractTextFromAdf(descriptionField) || '';

    // Extract URLs from ADF link marks / inlineCards AND plain-text regex, deduplicated
    const descriptionAdf = descriptionField && typeof descriptionField === 'object' ? descriptionField : null;
    const extractedUrls = extractAndFilterUrls(description, descriptionAdf);

    const status =
      fields.status && typeof fields.status === 'object' && typeof fields.status.name === 'string'
        ? fields.status.name
        : null;

    let assignee = null;
    if (fields.assignee && typeof fields.assignee === 'object') {
      if (typeof fields.assignee.displayName === 'string') {
        assignee = fields.assignee.displayName;
      }
    }

    const resolvedKey = typeof bodyJson.key === 'string' ? bodyJson.key : issueKey;
    const attachments = mapIssueAttachments(fields);

    return {
      issueKey: resolvedKey,
      summary,
      description,
      status,
      assignee,
      attachments,
      extractedUrls,
    };
  }

  /**
   * Download image attachments only; skip failures per file.
   * @param {Array<{ fileName?: string, filename?: string, mimeType?: string, url?: string }>} items
   * @returns {Promise<{ fileName: string, mimeType: string, base64: string }[]>}
   */
  async function fetchImageAttachmentsContent(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const results = [];
    let attemptedDownload = false;
    const failureStatuses = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const fileName = typeof item.fileName === 'string' ? item.fileName : typeof item.filename === 'string' ? item.filename : 'unknown';
      const mimeTypeRaw = typeof item.mimeType === 'string' ? item.mimeType : '';
      const url = typeof item.url === 'string' ? item.url : '';

      if (!url) {
        logger.warn('jira.attachment.skip', { fileName, reason: 'missing_url' });
        continue;
      }

      if (!isAllowedImageMime(mimeTypeRaw)) {
        logger.info('jira.attachment.skip', { fileName, reason: 'not_allowed_image_mime', mimeType: mimeTypeRaw });
        continue;
      }

      attemptedDownload = true;
      logger.jiraRequest('GET', url, { attachment: fileName });

      const dl = await downloadAttachment(url, { authorization: authHeader });
      if (!dl.ok) {
        logger.error('jira.attachment.download_failed', { fileName, error: dl.error, status: dl.status });
        failureStatuses.push(dl.status);
        continue;
      }

      if (dl.buffer.length > MAX_IMAGE_BYTES) {
        logger.warn('jira.attachment.skip', { fileName, reason: 'exceeds_max_bytes', max: MAX_IMAGE_BYTES });
        failureStatuses.push(undefined);
        continue;
      }

      results.push({
        fileName,
        mimeType: mimeTypeRaw.split(';')[0].trim() || 'application/octet-stream',
        base64: dl.buffer.toString('base64'),
      });
    }

    if (
      attemptedDownload &&
      results.length === 0 &&
      failureStatuses.length > 0 &&
      failureStatuses.every((s) => s === 401)
    ) {
      throw new JiraServiceError(
        'UNAUTHORIZED',
        'All image attachment downloads returned 401. Verify JIRA_EMAIL and JIRA_API_TOKEN.',
        {},
      );
    }

    return results;
  }

  return { getIssue, fetchImageAttachmentsContent };
}
