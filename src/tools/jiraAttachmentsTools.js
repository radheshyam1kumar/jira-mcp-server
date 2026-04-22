import * as z from 'zod/v4';
import { createJiraService, JiraServiceError } from '../services/jiraService.js';
import { pipelineTracker } from '../services/pipelineTracker.js';
import { logger } from '../utils/logger.js';
import { normalizeIssueKey } from '../utils/issueKey.js';

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

const attachmentMetaSchema = z.object({
  fileName: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  url: z.string().min(1).describe('Jira attachment content URL (from jira_get_issue.attachments[].url)'),
});

export function registerJiraAttachmentsTools(mcpServer, config) {
  const isConfigured =
    Boolean(config) &&
    typeof config === 'object' &&
    Boolean(String(config.jiraBaseUrl || '').trim()) &&
    Boolean(String(config.jiraEmail || '').trim()) &&
    Boolean(String(config.jiraApiToken || '').trim());

  const jira = isConfigured ? createJiraService(config) : null;

  mcpServer.registerTool(
    'jira_get_attachments_content',
    {
      title: 'Download Jira image attachments as base64',
      description:
        'Accepts attachment metadata (e.g. from jira_get_issue). Downloads only image/png, image/jpeg, image/jpg, image/webp. Returns base64 per file; skips failed downloads. Does not perform AI analysis.',
      inputSchema: {
        attachments: z
          .array(attachmentMetaSchema)
          .describe('Array of attachment objects with url, fileName/filename, and mimeType'),
        issueKey: z
          .string()
          .optional()
          .describe('Jira key for pipeline activity logs (e.g. IPG-1096).'),
      },
    },
    async ({ attachments, issueKey }) => {
      logger.toolCall('jira_get_attachments_content', { count: Array.isArray(attachments) ? attachments.length : 0 });
      const tk = normalizeIssueKey(issueKey);
      if (tk) {
        await pipelineTracker.ensure(tk);
        await pipelineTracker.log(tk, 'Downloading Jira image attachments…');
      }

      if (!jira) {
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'JIRA_NOT_CONFIGURED',
                message:
                  'Jira user config is missing required fields (JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN). Server stays up; configure user credentials and retry.',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const normalized = (attachments ?? []).map((a) => ({
          fileName: a.fileName || a.filename || 'unknown',
          mimeType: a.mimeType || '',
          url: a.url,
        }));

        const payload = await jira.fetchImageAttachmentsContent(normalized);
        if (tk) {
          await pipelineTracker.log(tk, 'Downloaded Jira image attachments for analysis.');
        }
        return {
          content: [{ type: 'text', text: formatToolJson(payload) }],
        };
      } catch (err) {
        if (err instanceof JiraServiceError) {
          logger.error('jira_get_attachments_content.failed', { code: err.code, message: err.message });
          if (tk) await pipelineTracker.log(tk, `Jira attachment download failed: ${err.message}`);
          return {
            content: [{ type: 'text', text: formatToolJson(err.toAiPayload()) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jira_get_attachments_content.unexpected', { message });
        if (tk) await pipelineTracker.log(tk, `Jira attachment download failed: ${message}`);
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'INTERNAL_ERROR',
                message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
