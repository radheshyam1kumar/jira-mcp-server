import * as z from 'zod/v4';
import { pipelineTracker } from '../services/pipelineTracker.js';
import { TICKET_KEY_PATTERN } from '../utils/issueKey.js';
import { logger } from '../utils/logger.js';
import { normalizeIssueKey } from '../utils/issueKey.js';

const PIPELINE_STAGE_ID = z.enum([
  'FETCH_JIRA',
  'ANALYZE_JIRA',
  'DEVELOPMENT',
  'COMMIT',
  'RAISE_PR',
  'MERGED_PR',
  'BUILD',
  'DEPLOY',
]);

const PIPELINE_STAGE_STATUS = z.enum(['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED']);

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function summarizeTicketResult(result) {
  if (!result || result.ok === false) {
    return {
      pipelineApiOk: false,
      error: result?.error || 'unknown',
      httpStatus: result?.status,
    };
  }
  const t = result.ticket;
  const stages = Array.isArray(t?.stages) ? t.stages : [];
  return {
    pipelineApiOk: true,
    issueKey: t?.issueKey,
    progress: t?.progress,
    pipelineStatus: t?.currentStatus,
    stages: stages.map((s) => ({ id: s.id, status: s.status })),
    cost: t?.cost,
  };
}

export function registerPipelineDashboardTools(mcpServer) {
  mcpServer.registerTool(
    'jira_pipeline_update_stage',
    {
      title: 'Update Jira pipeline stage (dashboard)',
      description:
        'Posts a STAGE event to the pipeline API so the job dashboard advances (e.g. after local Cursor work when Bitbucket MCP was not used). Requires PIPELINE_API_BASE_URL (and optional PIPELINE_INTERNAL_SECRET) matching the Express backend. Setting COMMIT to SUCCESS also marks earlier stages SUCCESS per server rules.',
      inputSchema: {
        issueKey: z
          .string()
          .regex(TICKET_KEY_PATTERN)
          .describe('Jira issue key, e.g. PG-3478'),
        stageId: PIPELINE_STAGE_ID.describe('Pipeline stage id'),
        stageStatus: PIPELINE_STAGE_STATUS.describe('New status for this stage'),
        description: z
          .string()
          .max(2000)
          .optional()
          .describe('Optional note stored on FAIL / terminal transitions'),
      },
    },
    async (input) => {
      logger.toolCall('jira_pipeline_update_stage', {
        issueKey: input.issueKey,
        stageId: input.stageId,
        stageStatus: input.stageStatus,
      });
      const key = normalizeIssueKey(input.issueKey);
      if (!key) {
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message: 'Invalid issueKey.' }) }],
          isError: true,
        };
      }
      await pipelineTracker.ensure(key);
      await pipelineTracker.log(
        key,
        `Pipeline stage ${input.stageId} → ${input.stageStatus}${input.description ? `: ${input.description}` : ''}`,
      );
      const result = await pipelineTracker.stage(key, input.stageId, input.stageStatus, input.description);
      const summary = summarizeTicketResult(result);
      if (!summary.pipelineApiOk) {
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'PIPELINE_API_FAILED',
                message: summary.error,
                httpStatus: summary.httpStatus,
                hint: 'Ensure the backend is running and PIPELINE_API_BASE_URL / PIPELINE_INTERNAL_SECRET match.',
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: formatToolJson(summary) }] };
    },
  );

  mcpServer.registerTool(
    'jira_pipeline_record_llm_usage',
    {
      title: 'Record LLM usage for pipeline dashboard',
      description:
        'Posts LLM_USAGE so token totals and estimated cost update on the job dashboard. Accumulates per phase within the active pipeline run. Pass token counts from the model/SDK response (input_tokens / output_tokens or prompt_tokens / completion_tokens).',
      inputSchema: {
        issueKey: z.string().regex(TICKET_KEY_PATTERN).describe('Jira issue key'),
        phase: z
          .string()
          .min(1)
          .max(120)
          .describe('Logical phase name, e.g. development, plan, review'),
        model: z.string().max(200).optional().describe('Model id for pricing, e.g. claude-sonnet-4-20250514'),
        input_tokens: z.number().int().nonnegative().optional().describe('Anthropic-style input token count'),
        output_tokens: z.number().int().nonnegative().optional().describe('Anthropic-style output token count'),
        prompt_tokens: z.number().int().nonnegative().optional().describe('OpenAI-style prompt tokens'),
        completion_tokens: z.number().int().nonnegative().optional().describe('OpenAI-style completion tokens'),
      },
    },
    async (input) => {
      logger.toolCall('jira_pipeline_record_llm_usage', {
        issueKey: input.issueKey,
        phase: input.phase,
      });
      const key = normalizeIssueKey(input.issueKey);
      if (!key) {
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message: 'Invalid issueKey.' }) }],
          isError: true,
        };
      }
      const usage = {};
      if (input.input_tokens != null) usage.input_tokens = input.input_tokens;
      if (input.output_tokens != null) usage.output_tokens = input.output_tokens;
      if (input.prompt_tokens != null) usage.prompt_tokens = input.prompt_tokens;
      if (input.completion_tokens != null) usage.completion_tokens = input.completion_tokens;

      await pipelineTracker.ensure(key);
      const result = await pipelineTracker.recordLlmUsage(key, {
        phase: input.phase,
        model: input.model,
        usage: Object.keys(usage).length ? usage : null,
      });
      const summary = summarizeTicketResult(result);
      if (!summary.pipelineApiOk) {
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'PIPELINE_API_FAILED',
                message: summary.error,
                httpStatus: summary.httpStatus,
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: formatToolJson(summary) }] };
    },
  );

  mcpServer.registerTool(
    'jira_pipeline_mark_local_work',
    {
      title: 'Mark development or commit complete (local / Cursor workflow)',
      description:
        'Convenience for work done outside Bitbucket MCP: mark DEVELOPMENT as SUCCESS after coding, or COMMIT as SUCCESS after a local git commit (COMMIT SUCCESS also marks earlier stages including Development). Call from the agent when the user confirms implementation or commit is done.',
      inputSchema: {
        issueKey: z.string().regex(TICKET_KEY_PATTERN).describe('Jira issue key'),
        completed: z
          .enum(['development', 'commit'])
          .describe('development = code complete; commit = committed locally (advances dashboard through commit stage)'),
        note: z.string().max(500).optional().describe('Optional line appended to activity log'),
      },
    },
    async (input) => {
      logger.toolCall('jira_pipeline_mark_local_work', { issueKey: input.issueKey, completed: input.completed });
      const key = normalizeIssueKey(input.issueKey);
      if (!key) {
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message: 'Invalid issueKey.' }) }],
          isError: true,
        };
      }
      await pipelineTracker.ensure(key);
      const line =
        input.completed === 'commit'
          ? input.note || 'Marked commit complete (local/git workflow).'
          : input.note || 'Marked development complete (local/Cursor workflow).';
      await pipelineTracker.log(key, line);

      const stageId = input.completed === 'commit' ? 'COMMIT' : 'DEVELOPMENT';
      const result = await pipelineTracker.stage(key, stageId, 'SUCCESS', line);
      const summary = summarizeTicketResult(result);
      if (!summary.pipelineApiOk) {
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'PIPELINE_API_FAILED',
                message: summary.error,
                httpStatus: summary.httpStatus,
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: formatToolJson({ ...summary, completed: input.completed }) }] };
    },
  );
}
