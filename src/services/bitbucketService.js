import axios from 'axios';
import FormData from 'form-data';
import { buildBasicAuthHeader } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const API_BASE = 'https://api.bitbucket.org/2.0';

/** Form/meta field names that collide with repo paths if sent without disambiguation. */
const RESERVED_SRC_FIELD_NAMES = new Set(['message', 'branch', 'author', 'parents', 'files']);

/** Jira-style keys, e.g. IPG-754 — used for `{KEY}-dev` feature branches. */
export const TICKET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export class BitbucketServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BitbucketServiceError';
    this.code = code;
    this.details = details;
  }

  toPayload() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * @param {string} raw
 * @returns {string} Uppercase ticket key, e.g. IPG-754
 */
export function normalizeTicketKey(raw) {
  const t = String(raw ?? '').trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(t)) {
    throw new BitbucketServiceError('INVALID_TICKET', `Invalid ticket key "${raw}". Expected format like IPG-754.`, {
      ticketKey: raw ?? null,
    });
  }
  return t;
}

/** Bitbucket branch name convention: IPG-754-dev */
export function ticketFeatureBranchName(ticketKeyRaw) {
  return `${normalizeTicketKey(ticketKeyRaw)}-dev`;
}

function resolveRepo(cfg, override) {
  const workspace = String(override?.workspace ?? cfg.workspace).trim();
  const repoSlug = String(override?.repoSlug ?? cfg.repoSlug).trim();
  if (!workspace || !repoSlug) {
    throw new BitbucketServiceError('INVALID_CONFIG', 'workspace and repoSlug are required.', {
      workspace: workspace || null,
      repoSlug: repoSlug || null,
    });
  }
  return { workspace, repoSlug };
}

function repoRoot(cfg, override) {
  const { workspace, repoSlug } = resolveRepo(cfg, override);
  return `${API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

function formFieldNameForRepoPath(repoPath) {
  const normalized = String(repoPath).replace(/\\/g, '/').trim();
  if (!normalized) {
    throw new BitbucketServiceError('INVALID_PATH', 'File path must be a non-empty string.', { path: repoPath });
  }
  if (normalized.includes('..')) {
    throw new BitbucketServiceError('INVALID_PATH', 'Path traversal ("..") is not allowed.', { path: repoPath });
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  const base = normalized.split('/').pop();
  if (base && RESERVED_SRC_FIELD_NAMES.has(base)) {
    return `/${normalized}`;
  }
  return normalized;
}

function assertValidBranchName(name) {
  const n = String(name).trim();
  if (!n) {
    throw new BitbucketServiceError('INVALID_BRANCH', 'Branch name is required.');
  }
  if (/[\x00-\x1f\x7f]/.test(n) || n.includes('"')) {
    throw new BitbucketServiceError('INVALID_BRANCH', 'Branch name contains invalid characters.');
  }
  return n;
}

function mapStatusToCode(status) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422 || status === 400) return 'VALIDATION_ERROR';
  return 'HTTP_ERROR';
}

function throwIfNotOkAxios(res, context) {
  if (res.status >= 200 && res.status < 300) return;

  const data = res.data;
  let json = null;
  if (data != null && typeof data === 'object') {
    json = data;
  } else if (typeof data === 'string' && data) {
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
  }
  const bitbucketMessage =
    (json && json.error && json.error.message) || (json && json.message) || (typeof data === 'string' ? data : '') || '';
  const snippet = String(bitbucketMessage).trim().slice(0, 800);

  const code = mapStatusToCode(res.status);
  const human =
    code === 'UNAUTHORIZED'
      ? 'Bitbucket rejected credentials (401/403). Check BITBUCKET_USERNAME and BITBUCKET_API_TOKEN (App password).'
      : code === 'NOT_FOUND'
        ? `Bitbucket resource not found (404). ${snippet || 'Verify workspace, repo, branch, or pull request id.'}`
        : code === 'CONFLICT'
          ? `Bitbucket conflict (409). ${snippet || 'Branch may already exist, or merge blocked.'}`
          : snippet || `Bitbucket API error HTTP ${res.status}`;

  throw new BitbucketServiceError(code, human, {
    status: res.status,
    context,
    bitbucket: json,
  });
}

function normalizeResponseData(res) {
  const d = res.data;
  if (d == null || d === '') return null;
  if (typeof d === 'object') return d;
  if (typeof d === 'string') {
    try {
      return JSON.parse(d);
    } catch {
      return { _raw: d };
    }
  }
  return d;
}

/**
 * @param {object} config
 * @param {string} config.workspace
 * @param {string} config.repoSlug
 * @param {string} config.username  Atlassian email or Bitbucket username
 * @param {string} config.apiToken App password or API token
 */
export function createBitbucketService(config) {
  const authHeader = buildBasicAuthHeader(config.username, config.apiToken);
  const defaultBaseBranch = String(config.defaultBaseBranch ?? 'develop').trim() || 'develop';

  const http = axios.create({
    // Avoid axios default adapter chain (xhr → http → fetch): some MCP/embedded
    // Node runtimes have no global `fetch`, which makes the fetch adapter throw
    // ReferenceError ("fetch is not defined") before http is used.
    adapter: 'http',
    timeout: 120_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });

  async function bbRequest(method, url, { data, headers = {}, context, responseType, transformResponse } = {}) {
    logger.info('bitbucket.request', { method, url: url.replace(/\/\/[^@]+@/, '//***@') });
    try {
      const res = await http.request({
        method,
        url,
        data,
        headers,
        responseType: responseType ?? 'json',
        ...(transformResponse ? { transformResponse } : {}),
      });
      throwIfNotOkAxios(res, context);
      return res;
    } catch (err) {
      if (err instanceof BitbucketServiceError) throw err;
      if (typeof axios.isAxiosError === 'function' && axios.isAxiosError(err)) {
        const msg = err.message || 'Network error';
        throw new BitbucketServiceError('NETWORK_ERROR', `Bitbucket request failed: ${msg}`, {
          cause: err.code,
          context,
        });
      }
      throw err;
    }
  }

  /**
   * @param {string} branchName
   * @param {string} baseBranch
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function createBranch(branchName, baseBranch, repoOverride = undefined) {
    const newName = assertValidBranchName(branchName);
    const base = assertValidBranchName(baseBranch);
    const root = repoRoot(config, repoOverride);

    const refUrl = `${root}/refs/branches/${encodeURIComponent(base)}`;
    const baseRes = await bbRequest('GET', refUrl, { context: 'get_base_branch' });
    const refJson = normalizeResponseData(baseRes);
    const hash = refJson?.target?.hash;
    if (!hash || typeof hash !== 'string') {
      throw new BitbucketServiceError(
        'INVALID_RESPONSE',
        `Could not read tip commit hash for branch "${base}".`,
        { baseBranch: base },
      );
    }

    const createUrl = `${root}/refs/branches`;

    try {
      const res = await bbRequest('POST', createUrl, {
        data: { name: newName, target: { hash } },
        headers: { 'Content-Type': 'application/json' },
        context: 'create_branch',
      });
      const data = normalizeResponseData(res);
      return {
        ok: true,
        branch: newName,
        baseBranch: base,
        baseHash: hash,
        ref: data,
      };
    } catch (e) {
      if (e instanceof BitbucketServiceError && e.code === 'CONFLICT') {
        throw new BitbucketServiceError(
          'BRANCH_EXISTS',
          `Branch "${newName}" already exists or could not be created (409).`,
          { ...e.details, branch: newName },
        );
      }
      throw e;
    }
  }

  /**
   * @param {{ branch: string, message: string, files: Record<string, string> }} args
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function commitFiles({ branch, message, files }, repoOverride = undefined) {
    const b = assertValidBranchName(branch);
    const msg = String(message ?? '').trim();
    if (!msg) {
      throw new BitbucketServiceError('INVALID_INPUT', 'Commit message is required.');
    }
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new BitbucketServiceError('INVALID_INPUT', 'files must be a non-empty object map path → content.');
    }
    const entries = Object.entries(files);
    if (entries.length === 0) {
      throw new BitbucketServiceError('EMPTY_COMMIT', 'No files to commit. Provide at least one path in files.');
    }

    const form = new FormData();
    form.append('message', msg);
    form.append('branch', b);

    for (const [pathKey, content] of entries) {
      const fieldName = formFieldNameForRepoPath(pathKey);
      const buf = Buffer.from(content == null ? '' : String(content), 'utf8');
      const filename = pathKey.split('/').pop() || 'file';
      form.append(fieldName, buf, { filename });
    }

    const root = repoRoot(config, repoOverride);
    const url = `${root}/src`;

    const res = await bbRequest('POST', url, {
      data: form,
      headers: form.getHeaders(),
      context: 'commit_files',
    });

    const location = res.headers?.location || res.headers?.Location || null;
    const data = normalizeResponseData(res);

    return {
      ok: true,
      branch: b,
      status: res.status,
      location,
      response: data,
    };
  }

  /**
   * @param {{ title: string, source: string, destination: string, description?: string, closeSourceBranch?: boolean }} args
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function createPR(
    { title, source, destination, description = '', closeSourceBranch = false },
    repoOverride = undefined,
  ) {
    const t = String(title ?? '').trim();
    if (!t) {
      throw new BitbucketServiceError('INVALID_INPUT', 'Pull request title is required.');
    }
    const src = assertValidBranchName(source);
    const dest = assertValidBranchName(destination);
    const root = repoRoot(config, repoOverride);

    try {
      const res = await bbRequest('POST', `${root}/pullrequests`, {
        data: {
          title: t,
          description: String(description ?? ''),
          source: { branch: { name: src } },
          destination: { branch: { name: dest } },
          close_source_branch: Boolean(closeSourceBranch),
        },
        headers: { 'Content-Type': 'application/json' },
        context: 'create_pr',
      });
      const pr = normalizeResponseData(res);
      return {
        ok: true,
        pullRequestId: pr?.id ?? null,
        title: pr?.title ?? t,
        state: pr?.state ?? null,
        links: pr?.links ?? null,
        source: pr?.source?.branch?.name ?? src,
        destination: pr?.destination?.branch?.name ?? dest,
        raw: pr,
      };
    } catch (e) {
      if (
        e instanceof BitbucketServiceError &&
        (e.code === 'CONFLICT' || e.code === 'VALIDATION_ERROR' || e.details?.status === 400)
      ) {
        throw new BitbucketServiceError(
          'PR_CREATE_FAILED',
          e.message,
          { ...e.details, hint: 'An open pull request for this source branch may already exist.' },
        );
      }
      throw e;
    }
  }

  /**
   * @param {number} prId
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function getPRDiff(prId, repoOverride = undefined) {
    const id = Number(prId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BitbucketServiceError('INVALID_INPUT', 'prId must be a positive integer.');
    }
    const root = repoRoot(config, repoOverride);
    const url = `${root}/pullrequests/${id}/diff`;

    const res = await bbRequest('GET', url, {
      context: 'get_pr_diff',
      responseType: 'text',
      transformResponse: [(d) => d],
    });

    const contentType = (res.headers?.['content-type'] || res.headers?.['Content-Type'] || '') + '';
    const text = typeof res.data === 'string' ? res.data : String(res.data ?? '');

    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(text);
        return { ok: true, prId: id, contentType, format: 'json', diff: json };
      } catch {
        return { ok: true, prId: id, contentType, format: 'text', diff: text };
      }
    }

    return { ok: true, prId: id, contentType, format: 'text', diff: text };
  }

  /**
   * @param {number} prId
   * @param {string} message
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function postPRComment(prId, message, repoOverride = undefined) {
    const id = Number(prId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BitbucketServiceError('INVALID_INPUT', 'prId must be a positive integer.');
    }
    const raw = String(message ?? '').trim();
    if (!raw) {
      throw new BitbucketServiceError('INVALID_INPUT', 'Comment message is required.');
    }
    const root = repoRoot(config, repoOverride);

    const res = await bbRequest('POST', `${root}/pullrequests/${id}/comments`, {
      data: { content: { raw } },
      headers: { 'Content-Type': 'application/json' },
      context: 'post_pr_comment',
    });
    const data = normalizeResponseData(res);
    return { ok: true, prId: id, comment: data };
  }

  /**
   * @param {number} prId
   * @param {{ mergeStrategy?: 'merge_commit' | 'squash' | 'fast_forward', closeSourceBranch?: boolean }} [opts]
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function mergePR(prId, opts = {}, repoOverride = undefined) {
    const id = Number(prId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BitbucketServiceError('INVALID_INPUT', 'prId must be a positive integer.');
    }
    const mergeStrategy = opts.mergeStrategy ?? 'merge_commit';
    const root = repoRoot(config, repoOverride);

    const payload = {
      merge_strategy: mergeStrategy,
    };
    if (opts.closeSourceBranch !== undefined) {
      payload.close_source_branch = Boolean(opts.closeSourceBranch);
    }

    const res = await bbRequest('POST', `${root}/pullrequests/${id}/merge`, {
      data: payload,
      headers: { 'Content-Type': 'application/json' },
      context: 'merge_pr',
    });
    const data = normalizeResponseData(res);
    return { ok: true, prId: id, merge: data };
  }

  /**
   * Declines (closes) an open pull request without merging.
   *
   * @param {number} prId
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function declinePR(prId, repoOverride = undefined) {
    const id = Number(prId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BitbucketServiceError('INVALID_INPUT', 'prId must be a positive integer.');
    }
    const root = repoRoot(config, repoOverride);
    // Bitbucket Cloud accepts an empty POST body for decline (see REST docs).
    const res = await bbRequest('POST', `${root}/pullrequests/${id}/decline`, {
      context: 'decline_pr',
    });
    const data = normalizeResponseData(res);
    return { ok: true, prId: id, state: data?.state ?? null, links: data?.links ?? null, raw: data };
  }

  /**
   * @param {string} branchName
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function checkBranchExists(branchName, repoOverride = undefined) {
    const name = assertValidBranchName(branchName);
    const root = repoRoot(config, repoOverride);
    const url = `${root}/refs/branches/${encodeURIComponent(name)}`;

    try {
      const res = await http.get(url);

      if (res.status === 404) {
        return { exists: false, branch: name };
      }
      throwIfNotOkAxios(res, 'check_branch');
      const data = normalizeResponseData(res);
      return {
        exists: true,
        branch: name,
        tip: data?.target?.hash ?? null,
        raw: data,
      };
    } catch (err) {
      if (err instanceof BitbucketServiceError) throw err;
      if (typeof axios.isAxiosError === 'function' && axios.isAxiosError(err)) {
        throw new BitbucketServiceError('NETWORK_ERROR', `Bitbucket request failed: ${err.message}`, {
          cause: err.code,
          context: 'check_branch',
        });
      }
      throw err;
    }
  }

  /**
   * @param {{ sourceBranch: string, destinationBranch?: string, state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED' }} args
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function checkPRExists(
    { sourceBranch, destinationBranch, state = 'OPEN' },
    repoOverride = undefined,
  ) {
    const src = assertValidBranchName(sourceBranch);
    const root = repoRoot(config, repoOverride);

    let q = `source.branch.name="${src.replace(/"/g, '\\"')}"`;
    if (destinationBranch) {
      const d = assertValidBranchName(destinationBranch);
      q += ` AND destination.branch.name="${d.replace(/"/g, '\\"')}"`;
    }
    q += ` AND state="${state}"`;

    const url = `${root}/pullrequests?q=${encodeURIComponent(q)}`;
    const res = await bbRequest('GET', url, { context: 'check_pr_exists' });
    const data = normalizeResponseData(res);
    const values = Array.isArray(data?.values) ? data.values : [];
    const pr = values[0] ?? null;

    return {
      exists: values.length > 0,
      count: values.length,
      pullRequestId: pr?.id ?? null,
      title: pr?.title ?? null,
      state: pr?.state ?? null,
      values: values.map((p) => ({
        id: p.id,
        title: p.title,
        state: p.state,
        source: p.source?.branch?.name,
        destination: p.destination?.branch?.name,
      })),
    };
  }

  /**
   * Ticket workflow: ensure branch `{TICKET}-dev` exists (create from baseBranch or reuse).
   * REST-only — cannot read local git; pass baseBranch = user's current branch when known.
   *
   * @param {{ ticketKey: string, baseBranch?: string }} args
   * @param {{ workspace?: string, repoSlug?: string }} [repoOverride]
   */
  async function ensureTicketFeatureBranch({ ticketKey, baseBranch: baseBranchInput }, repoOverride = undefined) {
    const key = normalizeTicketKey(ticketKey);
    const featureBranch = `${key}-dev`;
    const base = assertValidBranchName(
      baseBranchInput != null && String(baseBranchInput).trim()
        ? String(baseBranchInput).trim()
        : defaultBaseBranch,
    );

    const existsResult = await checkBranchExists(featureBranch, repoOverride);
    if (existsResult.exists) {
      const openPr = await checkPRExists({ sourceBranch: featureBranch, state: 'OPEN' }, repoOverride);
      const fromOpenPr =
        openPr.exists && openPr.values[0]?.destination ? openPr.values[0].destination : null;
      const suggestedDestinationForPR = fromOpenPr ?? base;

      return {
        ok: true,
        ticketKey: key,
        branch: featureBranch,
        created: false,
        branchAlreadyExisted: true,
        baseBranchPassedOrDefault: base,
        suggestedDestinationForPR,
        destinationConfidence: fromOpenPr ? 'from_open_pull_request' : 'from_base_branch_argument_or_default',
        note: fromOpenPr
          ? `Branch already exists on Bitbucket. An open PR targets "${fromOpenPr}" — use that as destination when opening or updating a PR.`
          : `Branch already exists; no open PR found. Using "${base}" as suggested PR destination (baseBranch you passed, or reposConfig default / develop). Confirm with the user if that is wrong.`,
        openPullRequest: openPr.exists
          ? {
              id: openPr.pullRequestId,
              title: openPr.title,
              destination: fromOpenPr,
            }
          : null,
        localGitCheckoutHint: `git fetch origin && git checkout ${featureBranch}`,
        agentGuidance: {
          confirmWithUser:
            'Before bitbucket_create_pull_request, present title/description/commit message and ask: Proceed or Edit (Cursor-style).',
          useDestination: suggestedDestinationForPR,
          useSourceBranch: featureBranch,
          recommendedCommitMessageExample: `${key}: <short description>`,
        },
      };
    }

    await createBranch(featureBranch, base, repoOverride);
    return {
      ok: true,
      ticketKey: key,
      branch: featureBranch,
      created: true,
      branchAlreadyExisted: false,
      baseBranchPassedOrDefault: base,
      suggestedDestinationForPR: base,
      destinationConfidence: 'from_new_branch',
      note: `Created "${featureBranch}" from "${base}". Use suggestedDestinationForPR as the PR destination unless the user changes it.`,
      openPullRequest: null,
      localGitCheckoutHint: `git fetch origin && git checkout ${featureBranch}`,
      agentGuidance: {
        confirmWithUser:
          'Before bitbucket_create_pull_request, present title/description/commit message and ask: Proceed or Edit (Cursor-style).',
        useDestination: base,
        useSourceBranch: featureBranch,
        recommendedCommitMessageExample: `${key}: <short description>`,
      },
    };
  }

  return {
    createBranch,
    commitFiles,
    createPR,
    getPRDiff,
    postPRComment,
    mergePR,
    declinePR,
    checkBranchExists,
    checkPRExists,
    ensureTicketFeatureBranch,
  };
}

export { formFieldNameForRepoPath, RESERVED_SRC_FIELD_NAMES };
