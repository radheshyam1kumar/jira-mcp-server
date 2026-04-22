import * as z from 'zod/v4';
import { createJiraService, JiraServiceError } from '../services/jiraService.js';
import { pipelineTracker } from '../services/pipelineTracker.js';
import { logger } from '../utils/logger.js';
import { normalizeIssueKey } from '../utils/issueKey.js';
import { processUrl } from '../utils/processUrl.js';

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

export function registerJiraGetIssueTools(mcpServer, config) {
  const isConfigured =
    Boolean(config) &&
    typeof config === 'object' &&
    Boolean(String(config.jiraBaseUrl || '').trim()) &&
    Boolean(String(config.jiraEmail || '').trim()) &&
    Boolean(String(config.jiraApiToken || '').trim());

  const jira = isConfigured ? createJiraService(config) : null;

  mcpServer.registerTool(
    'jira_get_issue',
    {
      title: 'Get Jira issue',
      description:
        'Fetches a Jira Cloud issue by key (e.g. IPG-754) and returns issueKey, summary, description, status, assignee, and attachments metadata (fileName, mimeType, url). Use jira_get_attachments_content to download images as base64. When the user starts a new "develop" pass on an already-completed pipeline, set beginNewDevelopmentCycle: true so the dashboard resets stages to Development (PR URL history and activity logs are preserved).',
      inputSchema: {
        issueKey: z
          .string()
          .min(1)
          .describe('Jira issue key, e.g. IPG-754'),
        beginNewDevelopmentCycle: z
          .boolean()
          .optional()
          .describe(
            'If true, reset pipeline stages to start at Development after fetch (keeps prUrls and activityLogs). Use when user explicitly begins development again (e.g. "develop IPG-1096") on a ticket that already reached PR/build/deploy.',
          ),
      },
    },
    async ({ issueKey, beginNewDevelopmentCycle }) => {
      logger.toolCall('jira_get_issue', { issueKey, beginNewDevelopmentCycle: Boolean(beginNewDevelopmentCycle) });
      const pipelineKey = normalizeIssueKey(issueKey);
      if (pipelineKey) {
        await pipelineTracker.ensure(pipelineKey);
        await pipelineTracker.log(pipelineKey, 'Fetching Jira ticket…');
      }

      if (!jira) {
        if (pipelineKey) {
          await pipelineTracker.jiraFetchFailed(
            pipelineKey,
            'Jira is not configured (missing JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN).',
            'Jira is not configured for this MCP session.',
          );
        }
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
        const issue = await jira.getIssue(issueKey);

        // Process all extracted URLs concurrently; errors per-URL are isolated
        let links = [];
        if (Array.isArray(issue.extractedUrls) && issue.extractedUrls.length > 0) {
          logger.info('jira_get_issue.processing_links', {
            issueKey,
            count: issue.extractedUrls.length,
            urls: issue.extractedUrls,
          });
          links = await Promise.all(issue.extractedUrls.map(processUrl));
        }

        const payload = {
          issueKey: issue.issueKey,
          summary: issue.summary,
          description: issue.description,
          status: issue.status,
          assignee: issue.assignee,
          attachments: issue.attachments,
          links,
        };

        if (pipelineKey) {
          if (beginNewDevelopmentCycle) {
            await pipelineTracker.beginNewDevelopmentCycle(pipelineKey);
          }
          const desc = issue.description != null ? String(issue.description) : '';
          await pipelineTracker.jiraFetched(pipelineKey, {
            summary: issue.summary,
            jiraStatus: issue.status,
            descriptionPreview: desc.slice(0, 1500),
          });
        }

        return {
          content: [{ type: 'text', text: formatToolJson(payload) }],
        };
      } catch (err) {
        if (err instanceof JiraServiceError) {
          logger.error('jira_get_issue.failed', { code: err.code, message: err.message });
          if (pipelineKey) {
            await pipelineTracker.jiraFetchFailed(pipelineKey, err.message, err.message);
          }
          return {
            content: [{ type: 'text', text: formatToolJson(err.toAiPayload()) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jira_get_issue.unexpected', { message });
        if (pipelineKey) {
          await pipelineTracker.jiraFetchFailed(pipelineKey, message, message);
        }
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
