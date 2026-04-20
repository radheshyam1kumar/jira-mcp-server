import * as z from 'zod/v4';
import {
  BitbucketServiceError,
  TICKET_KEY_PATTERN,
  createBitbucketService,
} from '../services/bitbucketService.js';
import { logger } from '../utils/logger.js';

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function notConfiguredPayload() {
  return {
    error: true,
    code: 'BITBUCKET_NOT_CONFIGURED',
    message:
      'Bitbucket is not configured. Set BITBUCKET_WORKSPACE, BITBUCKET_REPO, BITBUCKET_USERNAME, and BITBUCKET_API_TOKEN under injected mcpServers.jira.env (use an App password for the token). Ticket branch default base: build.params.Branch or flat build.Branch in reposConfig[BITBUCKET_REPO] (falls back to develop if unset).',
  };
}

const optionalRepo = {
  workspace: z
    .string()
    .optional()
    .describe('Override BITBUCKET_WORKSPACE for this call only'),
  repo: z
    .string()
    .optional()
    .describe('Override BITBUCKET_REPO (repository slug) for this call only'),
};

function repoOverrideFromInput(input) {
  const o = {};
  if (input.workspace != null && String(input.workspace).trim()) o.workspace = String(input.workspace).trim();
  if (input.repo != null && String(input.repo).trim()) o.repoSlug = String(input.repo).trim();
  return Object.keys(o).length ? o : undefined;
}

export function registerBitbucketTools(mcpServer, bitbucketConfig) {
  const bb = bitbucketConfig ? createBitbucketService(bitbucketConfig) : null;

  function guard() {
    if (!bb) return notConfiguredPayload();
    return null;
  }

  mcpServer.registerTool(
    'bitbucket_ensure_ticket_branch',
    {
      title: 'Ensure Bitbucket ticket feature branch ({TICKET}-dev)',
      description:
        'Ticket-driven workflow (REST only, no git on server): ensures branch named like IPG-754-dev exists. If missing, creates it from baseBranch. If it already exists, does not recreate — returns hints to "switch" work to that branch. **baseBranch**: pass the branch the user is on locally (e.g. output of git branch --show-current) so the new branch is cut from the right place; if omitted, uses reposConfig[BITBUCKET_REPO] build.params.Branch or flat build.Branch (else develop). **PR destination**: when an open PR exists for this source branch, suggestedDestinationForPR is taken from it; otherwise suggestedDestinationForPR is baseBranch/default — confirm with the user if unsure. Agents should ask Proceed vs Edit before create_pull_request.',
      inputSchema: {
        ticketKey: z
          .string()
          .regex(TICKET_KEY_PATTERN)
          .describe('Jira issue key, e.g. IPG-754 or ipg-754 (normalized to uppercase)'),
        baseBranch: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Branch to create from when the feature branch does not exist yet — ideally the user\'s current local branch. If omitted, uses build.params.Branch or flat build.Branch for BITBUCKET_REPO (else develop).',
          ),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_ensure_ticket_branch', { ticketKey: input.ticketKey });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.ensureTicketFeatureBranch(
          { ticketKey: input.ticketKey, baseBranch: input.baseBranch },
          repoOverrideFromInput(input),
        );
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_ensure_ticket_branch');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_create_branch',
    {
      title: 'Create Bitbucket branch',
      description:
        'Creates a new branch from an existing base branch using Bitbucket Cloud REST API only (no git). Uses BITBUCKET_* env; optional workspace/repo overrides.',
      inputSchema: {
        branchName: z.string().min(1).describe('New branch name to create'),
        baseBranch: z.string().min(1).describe('Existing branch to branch from (e.g. develop)'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_create_branch', { branchName: input.branchName, baseBranch: input.baseBranch });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.createBranch(input.branchName, input.baseBranch, repoOverrideFromInput(input));
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_create_branch');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_commit_files',
    {
      title: 'Commit files on Bitbucket branch',
      description:
        'Creates a commit by uploading files via POST /2.0/repositories/.../src (multipart/form-data). No git. Paths are repo-relative (e.g. src/index.js). Empty files map is rejected.',
      inputSchema: {
        branch: z.string().min(1).describe('Branch to commit to'),
        message: z.string().min(1).describe('Commit message'),
        files: z
          .record(z.string(), z.string())
          .describe('Map of repo-relative path → file content (string). Example: { "src/foo.txt": "hello" }'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_commit_files', { branch: input.branch, paths: Object.keys(input.files || {}) });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.commitFiles(
          { branch: input.branch, message: input.message, files: input.files },
          repoOverrideFromInput(input),
        );
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_commit_files');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_create_pull_request',
    {
      title: 'Create Bitbucket pull request',
      description:
        'Opens a PR from source into destination. Prefer **destination = suggestedDestinationForPR** from bitbucket_ensure_ticket_branch so the PR targets the same branch the feature was cut from. Before calling, confirm title/body with the user (Proceed vs Edit). On errors, use bitbucket_check_pr_exists.',
      inputSchema: {
        title: z.string().min(1).describe('PR title'),
        source: z.string().min(1).describe('Source branch name'),
        destination: z.string().min(1).describe('Destination branch name (e.g. develop)'),
        description: z.string().optional().describe('PR description (markdown)'),
        closeSourceBranch: z
          .boolean()
          .optional()
          .describe('If true, close source branch after merge (when merged via Bitbucket)'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_create_pull_request', { source: input.source, destination: input.destination });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.createPR(
          {
            title: input.title,
            source: input.source,
            destination: input.destination,
            description: input.description ?? '',
            closeSourceBranch: input.closeSourceBranch ?? false,
          },
          repoOverrideFromInput(input),
        );
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_create_pull_request');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_get_pr_diff',
    {
      title: 'Get Bitbucket pull request diff',
      description: 'Fetches diff for a pull request id (GET .../pullrequests/{id}/diff). Returns JSON or text depending on API response.',
      inputSchema: {
        prId: z.number().int().positive().describe('Pull request numeric id'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_get_pr_diff', { prId: input.prId });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.getPRDiff(input.prId, repoOverrideFromInput(input));
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_get_pr_diff');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_comment_pull_request',
    {
      title: 'Comment on Bitbucket pull request',
      description: 'Adds an inline PR comment using content.raw (REST API).',
      inputSchema: {
        prId: z.number().int().positive().describe('Pull request numeric id'),
        message: z.string().min(1).describe('Comment body (plain / markdown per repo settings)'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_comment_pull_request', { prId: input.prId });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.postPRComment(input.prId, input.message, repoOverrideFromInput(input));
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_comment_pull_request');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_merge_pull_request',
    {
      title: 'Merge Bitbucket pull request',
      description:
        'Merges an open PR via POST .../merge. mergeStrategy: merge_commit (default), squash, or fast_forward.',
      inputSchema: {
        prId: z.number().int().positive().describe('Pull request numeric id'),
        mergeStrategy: z
          .enum(['merge_commit', 'squash', 'fast_forward'])
          .optional()
          .describe('Merge strategy (default merge_commit)'),
        closeSourceBranch: z.boolean().optional().describe('Whether to close the source branch after merge'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_merge_pull_request', { prId: input.prId });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.mergePR(
          input.prId,
          {
            mergeStrategy: input.mergeStrategy,
            closeSourceBranch: input.closeSourceBranch,
          },
          repoOverrideFromInput(input),
        );
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_merge_pull_request');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_decline_pull_request',
    {
      title: 'Decline (close) Bitbucket pull request',
      description:
        'Declines an open PR without merging (POST .../pullrequests/{id}/decline). Use when the user wants to close or abandon a pull request.',
      inputSchema: {
        prId: z.number().int().positive().describe('Pull request numeric id'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_decline_pull_request', { prId: input.prId });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.declinePR(input.prId, repoOverrideFromInput(input));
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_decline_pull_request');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_check_branch_exists',
    {
      title: 'Check if Bitbucket branch exists',
      description: 'GET refs/branches/{name}; returns exists and tip hash when present.',
      inputSchema: {
        branchName: z.string().min(1).describe('Branch name to check'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_check_branch_exists', { branchName: input.branchName });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.checkBranchExists(input.branchName, repoOverrideFromInput(input));
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_check_branch_exists');
      }
    },
  );

  mcpServer.registerTool(
    'bitbucket_check_pr_exists',
    {
      title: 'Check for open Bitbucket pull request',
      description:
        'Queries pullrequests with q= for source.branch.name and state. Use before create_pull_request to detect duplicates.',
      inputSchema: {
        sourceBranch: z.string().min(1).describe('Source branch name'),
        destinationBranch: z.string().optional().describe('If set, require this destination branch'),
        state: z
          .enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
          .optional()
          .describe('PR state filter (default OPEN)'),
        ...optionalRepo,
      },
    },
    async (input) => {
      logger.toolCall('bitbucket_check_pr_exists', { sourceBranch: input.sourceBranch });
      const err = guard();
      if (err) return { content: [{ type: 'text', text: formatToolJson(err) }], isError: true };
      try {
        const out = await bb.checkPRExists(
          {
            sourceBranch: input.sourceBranch,
            destinationBranch: input.destinationBranch,
            state: input.state ?? 'OPEN',
          },
          repoOverrideFromInput(input),
        );
        return { content: [{ type: 'text', text: formatToolJson(out) }] };
      } catch (e) {
        return handleBitbucketError(e, 'bitbucket_check_pr_exists');
      }
    },
  );
}

function handleBitbucketError(err, tool) {
  if (err instanceof BitbucketServiceError) {
    logger.error(`${tool}.failed`, { code: err.code, message: err.message });
    return {
      content: [{ type: 'text', text: formatToolJson(err.toPayload()) }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`${tool}.unexpected`, { message });
  return {
    content: [{ type: 'text', text: formatToolJson({ error: true, code: 'INTERNAL_ERROR', message }) }],
    isError: true,
  };
}
