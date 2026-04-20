import { getReposConfigBuildDefaultBranch } from '../utils/repoConfig.js';

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

/** Injected `mcpServers.jira.env` (remote DB / single-user stub); no file path. */
let runtimeJiraEnvOverride = null;

function readMcpJsonJiraEnvObject() {
  if (runtimeJiraEnvOverride && typeof runtimeJiraEnvOverride === 'object') {
    return runtimeJiraEnvOverride;
  }
  return {};
}

/** Inject runtime Jira env object (e.g. per-user config fetched from DB). */
export function setRuntimeJiraEnvOverride(envObj) {
  runtimeJiraEnvOverride = envObj && typeof envObj === 'object' ? { ...envObj } : null;
}

/** Clear runtime Jira env (e.g. tests). */
export function clearMcpFileEnvCache() {
  runtimeJiraEnvOverride = null;
}

/**
 * Reads from injected `mcpServers.jira.env` only (see setRuntimeJiraEnvOverride).
 */
export function pickEnv(name) {
  const env = readMcpJsonJiraEnvObject();
  const file = env[name];
  if (file != null && String(file).trim() !== '') return String(file).trim();
  return '';
}

export function normalizeJiraDomain(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  let d = raw.trim();
  d = stripTrailingSlash(d);
  d = d.replace(/^https?:\/\//i, '');
  d = d.split('/')[0] ?? '';
  return d.trim();
}

export function getBitbucketConfig() {
  const workspace = pickEnv('BITBUCKET_WORKSPACE');
  const repoSlug = pickEnv('BITBUCKET_REPO');
  const username = pickEnv('BITBUCKET_USERNAME');
  const apiToken = pickEnv('BITBUCKET_API_TOKEN');

  if (!workspace || !repoSlug || !username || !apiToken) {
    return null;
  }
  const fromRepos = getReposConfigBuildDefaultBranch(repoSlug);
  const defaultBaseBranch = fromRepos || 'develop';
  return { workspace, repoSlug, username, apiToken, defaultBaseBranch };
}

export function loadConfig() {
  const domain = normalizeJiraDomain(pickEnv('JIRA_DOMAIN'));
  const email = pickEnv('JIRA_EMAIL');
  const apiToken = pickEnv('JIRA_API_TOKEN');

  const missing = [];
  if (!domain) missing.push('JIRA_DOMAIN');
  if (!email) missing.push('JIRA_EMAIL');
  if (!apiToken) missing.push('JIRA_API_TOKEN');

  if (missing.length > 0) {
    const err = new Error(
      `Missing required Jira variables in injected mcpServers.jira.env: ${missing.join(', ')}. Ensure the server called setRuntimeJiraEnvOverride with a full env object.`,
    );
    err.code = 'CONFIG_ERROR';
    throw err;
  }

  return {
    jiraDomain: domain,
    jiraEmail: email,
    jiraApiToken: apiToken,
    jiraBaseUrl: `https://${domain}`,
  };
}
