import * as z from 'zod/v4';
import { JenkinsBuildPipeline } from '../services/jenkinsBuildPipeline.js';
import { logger } from '../utils/logger.js';
import {
  RepoConfigError,
  formatBuildConfirmationPrompt,
  getBuildSampleArtifactReference,
  mergeJenkinsBuildParams,
  resolveJenkinsBuildConnection,
  resolveJenkinsBuildInput,
} from '../utils/repoConfig.js';

function formatToolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function notConfiguredPayload() {
  return {
    error: true,
    code: 'JENKINS_NOT_CONFIGURED',
    message:
      'Jenkins build is not configured. Add baseUrl (or JENKINS_BUILD_BASE_URL), jobPath (or JENKINS_BUILD_JOB_PATH), username (or JENKINS_BUILD_USERNAME), and apiToken (or JENKINS_BUILD_API_TOKEN) inside reposConfig[repoKey].build (or reposConfig[repoKey].build.connection) in injected reposConfig.',
  };
}

/** Arbitrary Jenkins build parameter names and values — must match the job’s parameter definitions. */
const jenkinsParamRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const buildParamOverrides = {
  params: jenkinsParamRecord
    .optional()
    .describe(
      'Overrides merged on top of mcpServers.jira.reposConfig[repoKey].build.params and non-reserved build fields. Keys are your Jenkins job parameter names (any).',
    ),
  extraParams: jenkinsParamRecord
    .optional()
    .describe('Merged after params; on duplicate keys, extraParams wins.'),
  jobPath: z
    .string()
    .optional()
    .describe(
      'Optional job path override for this run (default from reposConfig[repoKey].build), e.g. /job/team/job/job-name',
    ),
};

export function registerJenkinsBuildTools(mcpServer) {
  function createPipeline(conn, jobPathOverride) {
    if (!conn) return null;
    return new JenkinsBuildPipeline({
      ...conn,
      ...(jobPathOverride ? { jobPathOverride } : {}),
    });
  }

  function toBuildParams(merged) {
    return merged;
  }

  mcpServer.registerTool(
    'jenkins_prepare_build',
    {
      title: 'Prepare Jenkins build parameters (reposConfig + confirmation text)',
      description:
        'Loads Jenkins POST parameters from reposConfig[repoKey].build (build.params + non-reserved build fields). Tool params/extraParams override file values. Optional build.SAMPLE_FILE_URL (or build.SAMPLE_FILE) is for confirmation only — not sent to Jenkins. The assistant MUST show confirmationPrompt and wait for explicit user approval before calling jenkins_run_build.',
      inputSchema: {
        repoKey: z.string().min(1).describe('Entry key in mcpServers.jira.reposConfig, e.g. ump2-ui'),
        jiraId: z
          .string()
          .optional()
          .describe('Optional Jira key for display only in confirmation text, e.g. IPG-1096'),
        ...buildParamOverrides,
      },
    },
    async (input) => {
      logger.toolCall('jenkins_prepare_build', { repoKey: input.repoKey, jiraId: input.jiraId });
      try {
        const merged = mergeJenkinsBuildParams(input.repoKey, {
          params: input.params,
          extraParams: input.extraParams,
        });
        const buildArtifactSample = getBuildSampleArtifactReference(input.repoKey);
        const confirmationPrompt = formatBuildConfirmationPrompt(input.jiraId, merged, {
          buildArtifactSample: buildArtifactSample || undefined,
        });
        const mergedPayload = toBuildParams(merged);
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
                  'After user chooses Proceed, call jenkins_run_build with mergedPayload and repoKey (and optional params/extraParams/jobPath). Do not run build without chat confirmation.',
              }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof RepoConfigError) {
          logger.error('jenkins_prepare_build.config_error', { code: err.code, message: err.message });
          return {
            content: [{ type: 'text', text: formatToolJson(err.toPayload()) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_prepare_build.failed', { message });
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    'jenkins_run_build',
    {
      title: 'Run Jenkins build and extract S3 artifact path',
      description:
        'Triggers parameterized build, waits for SUCCESS, extracts s3://…/*.tgz. Prefer jenkins_prepare_build → user confirms in chat → then this tool with same mergedPayload shape (repoKey + params/extraParams as used in prepare). Jenkins URL/credentials from reposConfig[repoKey].build — repoKey is required. Long-running.',
      inputSchema: {
        repoKey: z.string().min(1).describe('reposConfig key — required'),
        ...buildParamOverrides,
        waitForBuildTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Millis to wait for build to appear (default 300000)'),
        waitForCompletionTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Millis to wait for job to finish (default 600000)'),
      },
    },
    async (input) => {
      logger.toolCall('jenkins_run_build', { repoKey: input.repoKey });
      const conn = resolveJenkinsBuildConnection(input.repoKey);
      if (!conn) {
        return { content: [{ type: 'text', text: formatToolJson(notConfiguredPayload()) }], isError: true };
      }
      let params;
      try {
        params = toBuildParams(resolveJenkinsBuildInput(input));
      } catch (err) {
        if (err instanceof RepoConfigError) {
          return {
            content: [{ type: 'text', text: formatToolJson(err.toPayload()) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
      try {
        const pipeline = createPipeline(conn, input.jobPath);
        const result = await pipeline.run(params, {
          waitForBuildTimeoutMs: input.waitForBuildTimeoutMs,
          waitForCompletionTimeoutMs: input.waitForCompletionTimeoutMs,
        });
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                ok: true,
                ...result,
                deployHint: 'Pass s3Path to jenkins_prepare_deployment / jenkins_run_deployment.',
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_run_build.failed', { message });
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    'jenkins_get_build_console',
    {
      title: 'Get Jenkins build console log and optional S3 path',
      description:
        'Fetches consoleText for a build number; extracts s3://…/*.tgz if present. Log tail is truncated when very long. Requires repoKey — Jenkins URL/credentials come from reposConfig[repoKey].build.',
      inputSchema: {
        buildNumber: z.number().int().positive().describe('Jenkins build number'),
        repoKey: z
          .string()
          .min(1)
          .optional()
          .describe('reposConfig key — required for Jenkins URL/credentials from reposConfig[repoKey].build'),
        jobPath: buildParamOverrides.jobPath,
      },
    },
    async (input) => {
      logger.toolCall('jenkins_get_build_console', { buildNumber: input.buildNumber, repoKey: input.repoKey });
      const conn = resolveJenkinsBuildConnection(input.repoKey);
      if (!conn) {
        return { content: [{ type: 'text', text: formatToolJson(notConfiguredPayload()) }], isError: true };
      }
      try {
        const pipeline = createPipeline(conn, input.jobPath);
        const log = await pipeline.getConsoleLog(input.buildNumber);
        const s3Path = pipeline.extractS3Path(log);
        return {
          content: [
            {
              type: 'text',
              text: formatToolJson({
                ok: true,
                buildNumber: input.buildNumber,
                logChars: log.length,
                s3Path,
                logTail: log.length > 8000 ? `${log.slice(-8000)}\n… [truncated]` : log,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('jenkins_get_build_console.failed', { message });
        return {
          content: [{ type: 'text', text: formatToolJson({ error: true, message }) }],
          isError: true,
        };
      }
    },
  );
}
