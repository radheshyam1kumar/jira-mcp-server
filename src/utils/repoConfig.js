import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


export class RepoConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RepoConfigError';
    this.code = code;
    this.details = details;
  }

  toPayload() {
    return { error: true, code: this.code, message: this.message, details: this.details };
  }
}

let cachedJson = null;
let cachedPath = null;
let runtimeReposConfigOverride = null;

function parseJsonFile(p, label) {
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RepoConfigError('CONFIG_PARSE_ERROR', `Invalid JSON in ${label}: ${msg}`, { path: p });
  }
}

function ensureRepoMap(data, pathLabel) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RepoConfigError('CONFIG_INVALID', 'repos config must be a JSON object keyed by repo id', { path: pathLabel });
  }
  return data;
}

function extractReposFromMcpJson(mcpJson, p) {
  const servers = mcpJson?.mcpServers;
  const jira = servers?.jira;
  const reposConfig = jira?.reposConfig;
  if (!reposConfig || typeof reposConfig !== 'object' || Array.isArray(reposConfig)) {
    throw new RepoConfigError(
      'CONFIG_INVALID',
      'mcp.json must contain mcpServers.jira.reposConfig as an object.',
      { path: p },
    );
  }
  return reposConfig;
}

function loadFromMcpJsonFile(mcpPath) {
  if (!fs.existsSync(mcpPath)) {
    throw new RepoConfigError('CONFIG_NOT_FOUND', `mcp config not found: ${mcpPath}`, { path: mcpPath });
  }
  const json = parseJsonFile(mcpPath, 'mcp.json');
  const reposConfig = extractReposFromMcpJson(json, mcpPath);
  return ensureRepoMap(reposConfig, mcpPath);
}

export function loadReposConfig(customPath) {
  if (!customPath && runtimeReposConfigOverride && typeof runtimeReposConfigOverride === 'object') {
    return runtimeReposConfigOverride;
  }

  const p = (customPath || '').trim();
  if (!p) {
    throw new RepoConfigError(
      'CONFIG_NOT_SET',
      'reposConfig is not loaded. Call setRuntimeReposConfigOverride(...) with mcpServers.jira.reposConfig, or pass an absolute path to a JSON file to loadReposConfig(path).',
      {},
    );
  }

  if (cachedJson && cachedPath === p) {
    return cachedJson;
  }

  let data;
  if (p.endsWith('.json') && path.basename(p) === 'mcp.json') {
    data = loadFromMcpJsonFile(p);
  } else {
    if (!fs.existsSync(p)) {
      throw new RepoConfigError('CONFIG_NOT_FOUND', `repos config not found: ${p}`, { path: p });
    }
    data = ensureRepoMap(parseJsonFile(p, 'repos config'), p);
  }

  cachedJson = data;
  cachedPath = p;
  return cachedJson;
}

export function getRepoConfig(repoKey) {
  const key = String(repoKey ?? '').trim();
  if (!key) {
    throw new RepoConfigError('INVALID_REPO_KEY', 'repoKey is required', { repoKey: key });
  }
  const all = loadReposConfig();
  const entry = all[key];
  if (!entry || typeof entry !== 'object') {
    throw new RepoConfigError('UNKNOWN_REPO', `No entry for repoKey "${key}" in repos config`, {
      repoKey: key,
      knownKeys: Object.keys(all),
    });
  }
  return entry;
}

function pickString(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return '';
}

function pickValue(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') continue;
      return s;
    }
    return v;
  }
  return '';
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function normalizeParamMap(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      out[key] = s;
      continue;
    }
    out[key] = v;
  }
  return out;
}

function normalizeRequiredParams(raw, fallback) {
  if (!Array.isArray(raw)) return [...fallback];
  const vals = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  return vals.length > 0 ? vals : [...fallback];
}

/** Keys on `build` / `deploy` that are connection, nesting, or artifact hints — not Jenkins job parameters. */
function isReservedBuildConfigKey(k) {
  const key = String(k ?? '').trim();
  if (!key) return true;
  if (key === 'connection' || key === 'params' || key === 'requiredParams' || key === 'jobPath') return true;
  if (key === 'baseUrl' || key === 'username' || key === 'apiToken') return true;
  if (/^JENKINS_/i.test(key)) return true;
  if (/^SAMPLE_FILE/i.test(key)) return true;
  return false;
}

function isReservedDeployConfigKey(k) {
  const key = String(k ?? '').trim();
  if (!key) return true;
  if (key === 'connection' || key === 'params' || key === 'requiredParams' || key === 'jobPath') return true;
  if (key === 'baseUrl' || key === 'username' || key === 'apiToken') return true;
  if (/^JENKINS_/i.test(key)) return true;
  if (/^SAMPLE_FILE/i.test(key)) return true;
  if (key === 'sampleS3UriParamName' || key === 'sampleUriParamName') return true;
  return false;
}

/**
 * Jenkins POST parameters from `build`: `build.params` plus any primitive fields on `build` that are not
 * connection / SAMPLE_FILE hints / merge metadata (see {@link isReservedBuildConfigKey}).
 */
function collectBuildParamsFromConfig(b) {
  if (!b || typeof b !== 'object') return {};
  const out = { ...normalizeParamMap(b.params) };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'params' || isReservedBuildConfigKey(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      out[k] = s;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Jenkins POST parameters from `deploy`: `deploy.params` plus non-reserved primitives on `deploy`.
 * `SAMPLE_FILE*` stay reserved — used only for basename / confirmation, not copied as arbitrary flat keys here
 * (see {@link mergeJenkinsDeployParams}).
 */
function collectDeployParamsFromConfig(d) {
  if (!d || typeof d !== 'object') return {};
  const out = { ...normalizeParamMap(d.params) };
  for (const [k, v] of Object.entries(d)) {
    if (k === 'params' || isReservedDeployConfigKey(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      out[k] = s;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function validateRequiredParams(merged, required, code, message, details = {}) {
  const missing = required.filter((k) => {
    const v = merged[k];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  });
  if (missing.length > 0) {
    throw new RepoConfigError(code, `${message}: ${missing.join(', ')}`, {
      ...details,
      missing,
      required,
      merged,
    });
  }
}

/**
 * Reads Jenkins build connection from `reposConfig[repoKey].build`.
 * Accepts the following key aliases (flat on `build`, or nested under `build.connection`):
 *   baseUrl / JENKINS_BUILD_BASE_URL, jobPath / JENKINS_BUILD_JOB_PATH,
 *   username / JENKINS_BUILD_USERNAME, apiToken / JENKINS_BUILD_API_TOKEN
 * @returns {{ baseUrl: string, jobPath: string, username: string, apiToken: string } | null}
 */
export function resolveJenkinsBuildConnection(repoKey) {
  const rk = repoKey != null ? String(repoKey).trim() : '';
  if (!rk) return null;
  const entry = getRepoConfig(rk);
  const b = entry.build && typeof entry.build === 'object' ? entry.build : {};
  const c = b.connection && typeof b.connection === 'object' ? b.connection : {};
  const conn = {
    baseUrl: pickString(c.baseUrl, c.JENKINS_BUILD_BASE_URL, b.JENKINS_BUILD_BASE_URL, b.baseUrl).replace(/\/+$/, ''),
    jobPath: pickString(c.jobPath, c.JENKINS_BUILD_JOB_PATH, b.JENKINS_BUILD_JOB_PATH, b.jobPath),
    username: pickString(c.username, c.JENKINS_BUILD_USERNAME, b.JENKINS_BUILD_USERNAME, b.username),
    apiToken: pickString(c.apiToken, c.JENKINS_BUILD_API_TOKEN, b.JENKINS_BUILD_API_TOKEN, b.apiToken),
  };
  if (!conn.baseUrl || !conn.jobPath || !conn.username || !conn.apiToken) return null;
  return conn;
}

/**
 * Reads Jenkins deployment connection from `reposConfig[repoKey].deploy`.
 * Accepts the following key aliases (flat on `deploy`, or nested under `deploy.connection`):
 *   baseUrl / JENKINS_DEPLOYMENT_BASE_URL, jobPath / JENKINS_DEPLOYMENT_JOB_PATH,
 *   username / JENKINS_DEPLOYMENT_USERNAME, apiToken / JENKINS_DEPLOYMENT_API_TOKEN
 * @returns {{ baseUrl: string, jobPath: string, username: string, apiToken: string } | null}
 */
export function resolveJenkinsDeploymentConnection(repoKey) {
  const rk = repoKey != null ? String(repoKey).trim() : '';
  if (!rk) return null;
  const entry = getRepoConfig(rk);
  const d = entry.deploy && typeof entry.deploy === 'object' ? entry.deploy : {};
  const c = d.connection && typeof d.connection === 'object' ? d.connection : {};
  const conn = {
    baseUrl: pickString(c.baseUrl, c.JENKINS_DEPLOYMENT_BASE_URL, d.JENKINS_DEPLOYMENT_BASE_URL, d.baseUrl).replace(/\/+$/, ''),
    jobPath: pickString(c.jobPath, c.JENKINS_DEPLOYMENT_JOB_PATH, d.JENKINS_DEPLOYMENT_JOB_PATH, d.jobPath),
    username: pickString(c.username, c.JENKINS_DEPLOYMENT_USERNAME, d.JENKINS_DEPLOYMENT_USERNAME, d.username),
    apiToken: pickString(c.apiToken, c.JENKINS_DEPLOYMENT_API_TOKEN, d.JENKINS_DEPLOYMENT_API_TOKEN, d.apiToken),
  };
  if (!conn.baseUrl || !conn.jobPath || !conn.username || !conn.apiToken) return null;
  return conn;
}

export function zipBasenameFromS3Path(s3PathOrUrl) {
  if (!s3PathOrUrl || typeof s3PathOrUrl !== 'string') return '';
  const s = s3PathOrUrl.trim();
  const noScheme = s.replace(/^s3:\/\/[^/]+\//i, '');
  const parts = noScheme.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Expected artifact location after build / deploy hint:
 * prefer `SAMPLE_FILE_URL` (full `s3://…` or path shape); `SAMPLE_FILE` is still accepted.
 * Build: **reference only** — not sent to Jenkins.
 * Deploy: basename feeds the artifact param (e.g. `ZIP_FILE`); a full `s3://…` value is also sent under
 * `deploy.sampleS3UriParamName` (default `SAMPLE_FILE_URL`) when the job needs the upload path.
 */
export function artifactBasenameFromSampleFile(sample) {
  if (!sample || typeof sample !== 'string') return '';
  const s = sample.trim();
  if (!s) return '';
  if (/^s3:\/\//i.test(s)) return zipBasenameFromS3Path(s);
  return s;
}

/** Expected artifact hint from build config (not sent to Jenkins). Prefer `SAMPLE_FILE_URL`, then `SAMPLE_FILE`. */
export function getBuildSampleArtifactReference(repoKey) {
  try {
    const b = getRepoConfig(repoKey).build;
    if (!b || typeof b !== 'object') return '';
    return pickString(b.SAMPLE_FILE_URL, b.SAMPLE_FILE);
  } catch {
    return '';
  }
}

/** Deploy sample path for confirmation (same source as basename / full-uri merge). Prefer `SAMPLE_FILE_URL`, then `SAMPLE_FILE`. */
export function getDeploySampleArtifactReference(repoKey) {
  try {
    const d = getRepoConfig(repoKey).deploy;
    if (!d || typeof d !== 'object') return '';
    return pickString(d.SAMPLE_FILE_URL, d.SAMPLE_FILE);
  } catch {
    return '';
  }
}

/** Jenkins parameter name for the full `s3://…` deploy path when passed through (default `SAMPLE_FILE_URL`). Empty string = omit. Tool overrides win over reposConfig.deploy. */
function resolveDeploySampleUriParamName(d, overrides = {}) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'sampleS3UriParamName') && overrides.sampleS3UriParamName === '') {
    return '';
  }
  const fromTool = pickString(overrides?.sampleS3UriParamName);
  if (fromTool) return fromTool;
  if (!d || typeof d !== 'object') return 'SAMPLE_FILE_URL';
  if (Object.prototype.hasOwnProperty.call(d, 'sampleS3UriParamName') && d.sampleS3UriParamName === '') {
    return '';
  }
  return pickString(d.sampleS3UriParamName, d.sampleUriParamName, 'SAMPLE_FILE_URL') || 'SAMPLE_FILE_URL';
}

export function getDeploySampleUriParamName(repoKey, toolOverrides = {}) {
  try {
    const d = getRepoConfig(repoKey).deploy;
    return resolveDeploySampleUriParamName(d && typeof d === 'object' ? d : {}, toolOverrides);
  } catch {
    return pickString(toolOverrides?.sampleS3UriParamName, 'SAMPLE_FILE_URL') || 'SAMPLE_FILE_URL';
  }
}

export function mergeJenkinsBuildParams(repoKey, overrides = {}) {
  const entry = getRepoConfig(repoKey);
  const b = entry.build && typeof entry.build === 'object' ? entry.build : {};

  const fromConfig = collectBuildParamsFromConfig(b);
  const merged = { ...fromConfig };

  Object.assign(merged, normalizeParamMap(overrides.params), normalizeParamMap(overrides.extraParams));

  const required = normalizeRequiredParams(b.requiredParams, []);
  validateRequiredParams(
    merged,
    required,
    'MISSING_BUILD_PARAMS',
    'Missing required Jenkins build fields after merge',
    { repoKey },
  );

  return merged;
}

/**
 * Default git branch for Bitbucket ticket-branch workflow: `build.params.Branch` or flat `build.Branch`
 * (legacy). Returns '' if missing. If `reposConfig` cannot be loaded, returns '' (caller may fall back,
 * e.g. to `develop`).
 */
export function getReposConfigBuildDefaultBranch(repoKey) {
  const key = String(repoKey ?? '').trim();
  if (!key) return '';
  try {
    const all = loadReposConfig();
    const entry = all[key];
    if (!entry || typeof entry !== 'object') return '';
    const b = entry.build && typeof entry.build === 'object' ? entry.build : {};
    const p = b.params && typeof b.params === 'object' ? b.params : {};
    return pickString(p.Branch, b.Branch);
  } catch (e) {
    if (e instanceof RepoConfigError) {
      const c = e.code;
      if (
        c === 'CONFIG_INVALID' ||
        c === 'CONFIG_NOT_FOUND' ||
        c === 'CONFIG_NOT_SET' ||
        c === 'CONFIG_PARSE_ERROR'
      ) {
        return '';
      }
    }
    throw e;
  }
}

export function mergeJenkinsBuildParamsExplicit(input) {
  const merged = {
    ...normalizeParamMap(input.params),
    ...normalizeParamMap(input.extraParams),
  };

  const required = normalizeRequiredParams(input.requiredParams, []);
  validateRequiredParams(
    merged,
    required,
    'MISSING_BUILD_PARAMS',
    'Missing required Jenkins build fields',
    { hint: 'Pass params explicitly or use repoKey with injected mcpServers.jira.reposConfig.' },
  );

  return merged;
}

export function mergeJenkinsDeployParams(repoKey, overrides = {}) {
  const entry = getRepoConfig(repoKey);
  const d = entry.deploy && typeof entry.deploy === 'object' ? entry.deploy : {};

  const fromS3 = overrides.s3Path ? zipBasenameFromS3Path(String(overrides.s3Path)) : '';
  const sampleForZip = pickString(
    overrides.SAMPLE_FILE_URL,
    overrides.SAMPLE_FILE,
    d.SAMPLE_FILE_URL,
    d.SAMPLE_FILE,
  );
  const fromSampleFile = artifactBasenameFromSampleFile(sampleForZip);
  const uriParamName = resolveDeploySampleUriParamName(d, overrides);

  const fromConfig = collectDeployParamsFromConfig(d);
  const merged = { ...fromConfig };

  Object.assign(merged, normalizeParamMap(overrides.params), normalizeParamMap(overrides.extraParams));

  merged.ZIP_FILE = pickString(merged.ZIP_FILE, fromS3, d.ZIP_FILE, fromSampleFile);

  // Full s3:// path for jobs that take an upload/source URL parameter (default key SAMPLE_FILE_URL).
  if (uriParamName && sampleForZip && /^s3:\/\//i.test(sampleForZip)) {
    merged[uriParamName] = sampleForZip;
  }

  const required = normalizeRequiredParams(d.requiredParams, []);
  validateRequiredParams(
    merged,
    required,
    'MISSING_DEPLOY_PARAMS',
    'Missing required Jenkins deploy fields after merge',
    { repoKey },
  );

  return merged;
}

export function mergeJenkinsDeployParamsExplicit(input) {
  const fromS3 = input.s3Path ? zipBasenameFromS3Path(String(input.s3Path)) : '';
  const sampleRaw = pickString(input.SAMPLE_FILE_URL, input.SAMPLE_FILE);
  const fromSample = artifactBasenameFromSampleFile(sampleRaw);
  const uriParamExplicit =
    input && Object.prototype.hasOwnProperty.call(input, 'sampleS3UriParamName') && input.sampleS3UriParamName === ''
      ? ''
      : pickString(input?.sampleS3UriParamName, 'SAMPLE_FILE_URL') || 'SAMPLE_FILE_URL';
  const merged = {
    ...normalizeParamMap(input.params),
    ...normalizeParamMap(input.extraParams),
  };
  merged.ZIP_FILE = pickString(merged.ZIP_FILE, fromS3, fromSample);
  if (uriParamExplicit && sampleRaw && /^s3:\/\//i.test(sampleRaw)) {
    merged[uriParamExplicit] = sampleRaw;
  }
  const required = normalizeRequiredParams(input.requiredParams, []);
  validateRequiredParams(
    merged,
    required,
    'MISSING_DEPLOY_PARAMS',
    'Missing required Jenkins deploy fields',
    { hint: 'Pass params explicitly or use repoKey with injected mcpServers.jira.reposConfig and s3Path/ZIP_FILE.' },
  );

  return merged;
}

export function formatBuildConfirmationPrompt(jiraId, params, options = {}) {
  const jid = jiraId && String(jiraId).trim() ? String(jiraId).trim() : '(JIRA_ID)';
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort();
  const lines = keys.map((k) => {
    const value = params[k] === '' ? '(empty)' : String(params[k]);
    const label = `${k}`.padEnd(12, ' ');
    return `${label}: ${value}`;
  });
  const sampleNote =
    options.buildArtifactSample && String(options.buildArtifactSample).trim()
      ? `\n\nExpected artifact after a successful build (reference only — not sent to Jenkins):\n  ${String(options.buildArtifactSample).trim()}`
      : '';
  return `Build Configuration for ${jid}:

${lines.join('\n')}${sampleNote}

Do you want to:
1. Proceed — call jenkins_run_build with mergedPayload (same values), after user confirms in chat
2. Modify values — user overrides fields; call jenkins_prepare_build again or jenkins_run_build with repoKey + overrides
3. Cancel — do not call jenkins_run_build`;
}

export function formatDeployConfirmationPrompt(params, options = {}) {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort();
  const lines = keys
    .filter((k) => params[k] !== undefined)
    .map((k) => {
      const value = params[k] === '' ? '(empty)' : String(params[k]);
      const label = `${k}`.padEnd(10, ' ');
      return `${label}: ${value}`;
    });
  const uriRaw = options.fullS3UriParamName;
  const uriTrimmed = uriRaw != null ? String(uriRaw).trim() : '';
  const uriExplain =
    uriRaw !== undefined && uriTrimmed === ''
      ? 'full s3:// URL is not sent as a separate Jenkins parameter for this run'
      : `full s3:// URL is sent as ${uriTrimmed || 'SAMPLE_FILE_URL'} when the job expects it`;
  const sampleNote =
    options.deploySampleReference && String(options.deploySampleReference).trim()
      ? `\n\nRepresentative artifact path from reposConfig (basename above is the ZIP_FILE value; ${uriExplain}):\n  ${String(options.deploySampleReference).trim()}`
      : '';
  return `Deployment Configuration:

${lines.join('\n')}${sampleNote}

Do you want to:
1. Proceed — call jenkins_run_deployment with mergedPayload after user confirms env + artifact basename in chat
2. Modify values — user overrides; call jenkins_prepare_deployment again or jenkins_run_deployment with repoKey + overrides
3. Cancel — do not call jenkins_run_deployment`;
}

export function resolveJenkinsBuildInput(input) {
  const repoKey = input.repoKey != null ? String(input.repoKey).trim() : '';
  if (repoKey) {
    return mergeJenkinsBuildParams(repoKey, {
      params: input.params,
      extraParams: input.extraParams,
    });
  }
  return mergeJenkinsBuildParamsExplicit({
    params: input.params,
    extraParams: input.extraParams,
    requiredParams: input.requiredParams,
  });
}

export function resolveJenkinsDeployInput(input) {
  const repoKey = input.repoKey != null ? String(input.repoKey).trim() : '';
  if (repoKey) {
    return mergeJenkinsDeployParams(repoKey, {
      params: input.params,
      extraParams: input.extraParams,
      s3Path: input.s3Path,
      SAMPLE_FILE_URL: input.SAMPLE_FILE_URL,
      SAMPLE_FILE: input.SAMPLE_FILE,
      sampleS3UriParamName: input.sampleS3UriParamName,
    });
  }
  return mergeJenkinsDeployParamsExplicit(input);
}

export function clearReposConfigCache() {
  cachedJson = null;
  cachedPath = null;
}

/** Inject runtime reposConfig object (e.g. per-user config fetched from DB). */
export function setRuntimeReposConfigOverride(reposConfigObj) {
  runtimeReposConfigOverride =
    reposConfigObj && typeof reposConfigObj === 'object' && !Array.isArray(reposConfigObj)
      ? reposConfigObj
      : null;
  cachedJson = null;
  cachedPath = null;
}
