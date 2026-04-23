import { logger } from '../utils/logger.js';
import { normalizeIssueKey } from '../utils/issueKey.js';

const BASE = String(process.env.PIPELINE_API_BASE_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');

function secretHeaders() {
  const s = String(process.env.PIPELINE_INTERNAL_SECRET || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (s) h['x-pipeline-secret'] = s;
  return h;
}

/**
 * @returns {Promise<{ ok: true, ticket: unknown } | { ok: false, status?: number, error: string }>}
 */
async function sendEvent(payload) {
  const issueKey = normalizeIssueKey(payload.issueKey);
  if (!issueKey) {
    return { ok: false, error: 'invalid_issue_key' };
  }
  const body = { ...payload, issueKey };
  try {
    const url = `${BASE}/api/internal/jira-pipeline/event`;
    const res = await fetch(url, {
      method: 'POST',
      headers: secretHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('pipeline_tracker.event_failed', {
        status: res.status,
        type: body.type,
        issueKey,
        body: text.slice(0, 500),
      });
      return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}` };
    }
    const ticket = await res.json().catch(() => null);
    return { ok: true, ticket };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('pipeline_tracker.unreachable', {
      issueKey,
      type: body.type,
      message,
    });
    return { ok: false, error: message };
  }
}

export const pipelineTracker = {
  ensure(issueKey) {
    return sendEvent({ type: 'ENSURE', issueKey });
  },
  log(issueKey, message) {
    return sendEvent({ type: 'LOG', issueKey, message });
  },
  stage(issueKey, stageId, stageStatus, description) {
    return sendEvent({ type: 'STAGE', issueKey, stageId, stageStatus, description });
  },
  jiraFetched(issueKey, fields) {
    return sendEvent({
      type: 'JIRA_FETCHED',
      issueKey,
      summary: fields?.summary,
      jiraStatus: fields?.jiraStatus,
      descriptionPreview: fields?.descriptionPreview,
    });
  },
  beginNewDevelopmentCycle(issueKey) {
    return sendEvent({ type: 'BEGIN_NEW_DEV_CYCLE', issueKey });
  },
  jiraFetchFailed(issueKey, message, description) {
    return sendEvent({
      type: 'JIRA_FETCH_FAILED',
      issueKey,
      message,
      description: description || message,
    });
  },
  setPrUrl(issueKey, prUrl) {
    return sendEvent({ type: 'SET_PR', issueKey, prUrl });
  },
  setRepository(issueKey, repository) {
    return sendEvent({ type: 'SET_REPOSITORY', issueKey, repository });
  },
  fail(issueKey, description) {
    return sendEvent({ type: 'FAIL', issueKey, description });
  },
  buildSuccess(issueKey) {
    return sendEvent({ type: 'BUILD_SUCCESS', issueKey });
  },
  deploySuccess(issueKey) {
    return sendEvent({ type: 'DEPLOY_SUCCESS', issueKey });
  },
  /**
   * Persist Anthropic usage for a logical SDLC phase (tokens accumulate across calls in the same phase).
   * @param {string} issueKey
   * @param {{ phase: string, model?: string, llmResponse?: unknown, usage?: { input_tokens?: number, output_tokens?: number } }} payload
   */
  recordLlmUsage(issueKey, payload) {
    return sendEvent({
      type: 'LLM_USAGE',
      issueKey,
      phase: payload?.phase,
      model: payload?.model,
      llmResponse: payload?.llmResponse ?? null,
      usage: payload?.usage ?? null,
    });
  },
};
