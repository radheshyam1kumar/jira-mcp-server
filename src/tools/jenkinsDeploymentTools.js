import * as z from 'zod/v4';
import { JenkinsDeploymentPipeline } from '../services/jenkinsDeploymentPipeline.js';
import { pipelineTracker } from '../services/pipelineTracker.js';
import { logger } from '../utils/logger.js';
import { normalizeIssueKey } from '../utils/issueKey.js';
import {
  RepoConfigError,
  formatDeployConfirmationPrompt,
  getDeploySampleArtifactReference,
  getDeploySampleUriParamName,
  mergeJenkinsDeployParams,
  resolveJenkinsDeployInput,
  resolveJenkinsDeploymentConnection,
} from '../utils/repoConfig.js';

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function notConfiguredPayload() {
  return {
    error: true,
    code: 'JENKINS_DEPLOYMENT_NOT_CONFIGURED',
    message:
      'Jenkins deployment is not configured. Add baseUrl (or JENKINS_DEPLOYMENT_BASE_URL), jobPath (or JENKINS_DEPLOYMENT_JOB_PATH), username (or JENKINS_DEPLOYMENT_USERNAME), and apiToken (or JENKINS_DEPLOYMENT_API_TOKEN) inside reposConfig[repoKey].deploy (or reposConfig[repoKey].deploy.connection) in injected reposConfig.',
  };
}

function resolvePipelineIssueKey(input) {
  return normalizeIssueKey(input?.issueKey || input?.jiraId);
}

const jenkinsParamRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const deployParamOverrides = {
  params: jenkinsParamRecord
    .optional()
    .describe(
      'Overrides merged on top of mcpServers.jira.reposConfig[repoKey].deploy.params and non-reserved deploy fields. Keys match your Jenkins deploy job (e.g. servicename, env, buildtype, ZIP_FILE).',
    ),
  extraParams: jenkinsParamRecord
    .optional()
    .describe('Merged after params; duplicate keys win from extraParams.'),
  s3Path: z
    .string()
    .optional()
    .describe(
      'Full s3://… path from jenkins_run_build; basename used as ZIP_FILE when not set in merged params.',
    ),
  SAMPLE_FILE_URL: z
    .string()
    .optional()
    .describe(
      'Overrides reposConfig.deploy.SAMPLE_FILE_URL for basename / full-uri merge (not a generic Jenkins param name).',
    ),
  SAMPLE_FILE: z
    .string()
    .optional()
    .describe('Legacy alias for SAMPLE_FILE_URL when SAMPLE_FILE_URL is unset.'),
  sampleS3UriParamName: z
    .string()
    .optional()
    .describe(
      'Jenkins parameter name for the full s3:// path (default SAMPLE_FILE_URL). Empty string omits that parameter.',
    ),
  jobPath: z
    .string()
    .optional()
    .describe('Override deployment job path for this run (default from reposConfig[repoKey].deploy.jobPath)'),
  issueKey: z
    .string()
    .optional()
    .describe('Jira key for pipeline dashboard (e.g. IPG-1096).'),
  jiraId: z
    .string()
    .optional()
    .describe('Optional Jira key alias (same purpose as issueKey), e.g. IPG-1096.'),
};

export function registerJenkinsDeploymentTools(mcpServer) {
  function createPipeline(conn, jobPathOverride) {
    if (!conn) return null;
    return new JenkinsDeploymentPipeline({
      ...conn,
      ...(jobPathOverride ? { jobPathOverride } : {}),
    });
  }

  function toDeployParams(merged) {
    return merged;
  }

  mcpServer.registerTool(
    'jenkins_prepare_deployment',
    {
      title: 'Prepare Jenkins deployment parameters (reposConfig + confirmation text)',
      description:
        'Merges reposConfig deploy defaults; ZIP_FILE is the artifact basename. deploy.SAMPLE_FILE_URL documents the expected full s3:// path (reference + merge: basename for ZIP_FILE, full URL sent as sampleS3UriParamName, default SAMPLE_FILE_URL, when the job needs it). Legacy deploy.SAMPLE_FILE still supported. Returns confirmationPrompt — assistant MUST get user confirmation before jenkins_run_deployment.',
      inputSchema: {
        repoKey: z.string().min(1).describe('Entry key in mcpServers.jira.reposConfig, e.g. ump2-ui'),
        ...deployParamOverrides,
      },
    },
    async (input) => {
      logger.toolCall('jenkins_prepare_deployment', { repoKey: input.repoKey, s3Path: input.s3Path });
      const tk = resolvePipelineIssueKey(input);
      if (tk) {
        await pipelineTracker.ensure(tk);
        await pipelineTracker.log(tk, 'Preparing Jenkins deployment parameters…');
      }
      try {
        const merged = mergeJenkinsDeployParams(input.repoKey, {
          params: input.params,
          extraParams: input.extraParams,
          s3Path: input.s3Path,
          SAMPLE_FILE_URL: input.SAMPLE_FILE_URL,
          SAMPLE_FILE: input.SAMPLE_FILE,
          sampleS3UriParamName: input.sampleS3UriParamName,
        });
        const deploySampleReference = getDeploySampleArtifactReference(input.repoKey);
        const fullS3UriParamName = getDeploySampleUriParamName(input.repoKey, {
          sampleS3UriParamName: input.sampleS3UriParamName,
        });
        const confirmationPrompt = formatDeployConfirmationPrompt(merged, {
          deploySampleReference: deploySampleReference || undefined,
          fullS3UriParamName,
        });
        const mergedPayload = toDeployParams(merged);
        if (tk) await pipelineTracker.log(tk, 'Jenkins deployment parameters prepared.');
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                ok: true,
                phase: 'confirm_required',
                confirmationPrompt,
                mergedPayload,
                runHint:
                  'After user confirms env + artifact, call jenkins_run_deployment with { ...mergedPayload, repoKey } or explicit fields. Do not deploy without chat confirmation.',
              }),
            },
          ],
        };
      } catch (err) {
        if (tk) {
          const msg = err instanceof Error ? err.message : String(err);
          await pipelineTracker.log(tk, `Prepare Jenkins deployment failed: ${msg}`);
        }
        if (err instanceof RepoConfigError) {
          logger.error('jenkins_prepare_deployment.config_error', { code: err.code, message: err.message });
          return {
            content: [{ type: 'text', text: formatToolJson(err.toPayload()) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_prepare_deployment.failed', { message });
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    'jenkins_run_deployment',
    {
      title: 'Run Jenkins deployment job',
      description:
        'Parameterized deployment. Jenkins POST body comes from reposConfig[repoKey].deploy (deploy.params + non-reserved fields), merged with tool params/extraParams; s3Path / SAMPLE_FILE_URL fill ZIP_FILE when needed. Prefer jenkins_prepare_deployment → confirm → this tool with same shape. repoKey required.',
      inputSchema: {
        repoKey: z.string().min(1).describe('reposConfig key — required'),
        ...deployParamOverrides,
        waitForBuildTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Millis to wait for run to appear (default 300000)'),
        waitForCompletionTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Millis to wait for job to finish (default 900000)'),
      },
    },
    async (input) => {
      logger.toolCall('jenkins_run_deployment', { repoKey: input.repoKey, s3Path: input.s3Path });
      const tk = resolvePipelineIssueKey(input);
      if (!tk) {
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                error: true,
                code: 'ISSUE_KEY_REQUIRED',
                message:
                  'issueKey (or jiraId) is required for deployment tracking. Pass Jira key like IPG-1096.',
              }),
            },
          ],
          isError: true,
        };
      }
      let params;
      try {
        params = toDeployParams(resolveJenkinsDeployInput(input));
      } catch (err) {
        const inputErrorMessage = err instanceof Error ? err.message : String(err);
        await pipelineTracker.fail(tk, `Jenkins deployment input: ${inputErrorMessage}`);
        if (err instanceof RepoConfigError) {
          return {
            content: [{ type: 'text', text: formatToolJson(err.toPayload()) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message: inputErrorMessage }) }],
          isError: true,
        };
      }
      if (tk) await pipelineTracker.ensure(tk);
      const conn = resolveJenkinsDeploymentConnection(input.repoKey);
      if (!conn) {
        if (tk) {
          await pipelineTracker.fail(tk, 'Jenkins deployment is not configured.');
        }
        return { content: [{ type: 'text', text: formatToolJson(notConfiguredPayload()) }], isError: true };
      }
      if (tk) {
        await pipelineTracker.log(tk, 'Running Jenkins deployment…');
        await pipelineTracker.stage(tk, 'DEPLOY', 'IN_PROGRESS');
      }
      try {
        const pipeline = createPipeline(conn, input.jobPath);
        const result = await pipeline.run(params, {
          waitForBuildTimeoutMs: input.waitForBuildTimeoutMs,
          waitForCompletionTimeoutMs: input.waitForCompletionTimeoutMs,
        });
        if (tk) {
          await pipelineTracker.deploySuccess(tk);
          await pipelineTracker.log(tk, 'Jenkins deployment finished with SUCCESS.');
        }
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                ok: true,
                ...result,
                hint: 'Deployment job finished with SUCCESS.',
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_run_deployment.failed', { message });
        if (tk) {
          await pipelineTracker.fail(tk, `Jenkins deployment: ${message}`);
        }
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    'jenkins_get_deployment_console',
    {
      title: 'Get Jenkins deployment job console log',
      description:
        'Fetches consoleText for a deployment job build number. Requires repoKey — Jenkins URL/credentials from reposConfig[repoKey].deploy.',
      inputSchema: {
        buildNumber: z.number().int().positive().describe('Jenkins build number'),
        repoKey: z
          .string()
          .min(1)
          .optional()
          .describe('reposConfig key — required for Jenkins URL/credentials from reposConfig[repoKey].deploy'),
        jobPath: deployParamOverrides.jobPath,
        issueKey: z
          .string()
          .optional()
          .describe('Optional Jira key for pipeline activity logs (e.g. IPG-1096).'),
        jiraId: z
          .string()
          .optional()
          .describe('Optional Jira key alias (same purpose as issueKey).'),
      },
    },
    async (input) => {
      logger.toolCall('jenkins_get_deployment_console', { buildNumber: input.buildNumber, repoKey: input.repoKey });
      const tk = resolvePipelineIssueKey(input);
      if (tk) {
        await pipelineTracker.ensure(tk);
        await pipelineTracker.log(tk, `Fetching Jenkins deployment console for #${input.buildNumber}…`);
      }
      const conn = resolveJenkinsDeploymentConnection(input.repoKey);
      if (!conn) {
        if (tk) {
          await pipelineTracker.log(tk, 'Jenkins deployment console fetch failed: Jenkins deployment is not configured.');
        }
        return { content: [{ type: 'text', text: formatToolJson(notConfiguredPayload()) }], isError: true };
      }
      try {
        const pipeline = createPipeline(conn, input.jobPath);
        const log = await pipeline.getConsoleLog(input.buildNumber);
        if (tk) await pipelineTracker.log(tk, `Fetched Jenkins deployment console for #${input.buildNumber}.`);
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                ok: true,
                buildNumber: input.buildNumber,
                logChars: log.length,
                logTail: log.length > 8000 ? `${log.slice(-8000)}\n… [truncated]` : log,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_get_deployment_console.failed', { message });
        if (tk) await pipelineTracker.log(tk, `Jenkins deployment console fetch failed: ${message}`);
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );
}
