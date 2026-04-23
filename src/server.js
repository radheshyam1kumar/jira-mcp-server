import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { getBitbucketConfig, loadConfig, setRuntimeJiraEnvOverride } from './config/env.js';
import { setRuntimeReposConfigOverride } from './utils/repoConfig.js';
import { logger } from './utils/logger.js';
import { registerJiraAttachmentsTools } from './tools/jiraAttachmentsTools.js';
import { registerJiraGetIssueTools } from './tools/jiraGetIssueTools.js';
import { registerJenkinsDeploymentTools } from './tools/jenkinsDeploymentTools.js';
import { registerBitbucketTools } from './tools/bitbucketTools.js';
import { registerJenkinsBuildTools } from './tools/jenkinsBuildTools.js';
import { registerPipelineDashboardTools } from './tools/pipelineDashboardTools.js';

const jiraToolRegistrars = [
  registerJiraGetIssueTools,
  registerJiraAttachmentsTools,
];

const SERVER_INSTRUCTIONS =
  'Jira Cloud + optional Jenkins + optional Bitbucket Cloud. Pipeline dashboard: tools update Firestore via the backend when PIPELINE_API_BASE_URL points at the Express API (default http://127.0.0.1:4001); set PIPELINE_INTERNAL_SECRET to match the API. Jira: jira_get_issue (registers/updates ticket), jira_get_attachments_content (optional issueKey for logs). Dashboard (Cursor): repo root `.cursor/hooks.json` can run `jira-mcp-server/scripts/cursor-hook-after-agent-response.mjs` on `afterAgentResponse` to POST estimated LLM_USAGE (transcript growth + assistant text; not vendor-reported usage). For exact usage from an API/SDK, call jira_pipeline_record_llm_usage. After substantive coding, call jira_pipeline_mark_local_work (completed: development | commit). jira_pipeline_update_stage for any stage. Jenkins build: pass issueKey on jenkins_run_build — successful build marks the Jira ticket CLOSED in the dashboard. Jenkins: jenkins_prepare_build then jenkins_run_build with mergedPayload/repoKey/issueKey; jenkins_get_build_console. Jenkins deploy: jenkins_prepare_deployment / jenkins_run_deployment (optional issueKey). Bitbucket: bitbucket_ensure_ticket_branch, bitbucket_commit_files, bitbucket_create_pull_request / bitbucket_merge_pull_request (pass issueKey when known for stage updates).';

function normalizeRuntimeSnapshot(rawConfig, sourcePath) {
  const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  const jiraNode = config?.mcpServers?.jira;
  const fromMcpShape = jiraNode && typeof jiraNode === 'object' && !Array.isArray(jiraNode);
  const envRaw = fromMcpShape ? jiraNode.env : config.env;
  const reposRaw = fromMcpShape ? jiraNode.reposConfig : config.reposConfig;
  const env = envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw) ? { ...envRaw } : {};
  const reposConfig =
    reposRaw && typeof reposRaw === 'object' && !Array.isArray(reposRaw) ? JSON.parse(JSON.stringify(reposRaw)) : {};
  return {
    sourcePath,
    snapshot: {
      mcpServers: {
        jira: {
          env,
          reposConfig,
        },
      },
    },
  };
}

function setRuntimeConfigFromSnapshot(sourcePath, snapshot, options = {}) {
  const { log = true } = options;
  setRuntimeJiraEnvOverride(snapshot?.mcpServers?.jira?.env || {});
  setRuntimeReposConfigOverride(snapshot?.mcpServers?.jira?.reposConfig || {});
  if (log) {
    logger.info('mcp.config.runtime_snapshot_ready', {
      sourcePath,
      runtimeConfigPath: 'in_memory_runtime_override',
      keys: {
        env: Object.keys(snapshot.mcpServers.jira.env || {}).length,
        reposConfig: Object.keys(snapshot.mcpServers.jira.reposConfig || {}).length,
      },
    });
  }
}

function computeServiceConfigForCurrentRuntime(sourcePath) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('config.load_failed_runtime_degraded', { message: msg, sourcePath });
    config = null;
  }
  const bitbucketConfig = getBitbucketConfig();
  return { config, bitbucketConfig };
}

function getHeaderValue(req, name) {
  const val = req.headers[name];
  if (Array.isArray(val)) return String(val[0] ?? '').trim();
  return String(val ?? '').trim();
}

function parseInlineHeaderConfig(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return null;

  const parseCandidate = (candidate) => {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string' && parsed.trim()) return JSON.parse(parsed);
    return null;
  };

  try {
    return parseCandidate(raw);
  } catch {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
      if (!raw) return null;
      return parseCandidate(raw);
    }
    throw new Error('Invalid X-MCP-CONFIG header JSON.');
  }
}

function resolveSnapshotFromRequestHeaders(req) {
  const inlineHeader = getHeaderValue(req, 'x-mcp-config');
  if (inlineHeader) {
    const parsed = parseInlineHeaderConfig(inlineHeader);
    return normalizeRuntimeSnapshot(parsed || {}, 'header:x-mcp-config');
  }
  throw new Error('X-MCP-CONFIG header is required for initialize.');
}

function createConfiguredMcpServer(config, bitbucketConfig) {
  const mcpServer = new McpServer(
    {
      name: 'jira-context-server',
      version: '1.0.0',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const register of jiraToolRegistrars) register(mcpServer, config);
  registerPipelineDashboardTools(mcpServer);
  registerJenkinsBuildTools(mcpServer);
  registerJenkinsDeploymentTools(mcpServer);
  registerBitbucketTools(mcpServer, bitbucketConfig);
  return mcpServer;
}

function parseHttpPort(raw, fallback = 3333) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function isAuthorizedRequest(req, authToken) {
  if (!authToken) return true;
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const expected = String(authToken).trim();
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === expected;
  }
  return authHeader.trim() === expected;
}

function writeJsonRpcError(res, status, message, code = -32000, id = null) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id,
  });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

async function closeSession(session, sessionsMap) {
  try {
    await session.transport.close();
  } catch {
    // ignore shutdown errors
  }
  try {
    await session.mcpServer?.server?.close?.();
  } catch {
    // ignore shutdown errors
  }
  sessionsMap.delete(session.sessionId);
}

async function startHttpServer() {
  if (typeof globalThis.Request === 'undefined') {
    throw new Error(
      'Remote streamable HTTP transport requires Node.js 18+ (global Request API missing). Please upgrade Node and retry.',
    );
  }
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const host = String(process.env.JIRA_MCP_HTTP_HOST || '127.0.0.1').trim();
  const port = parseHttpPort(process.env.JIRA_MCP_HTTP_PORT, 3333);
  const path = String(process.env.JIRA_MCP_HTTP_PATH || '/mcp').trim() || '/mcp';
  const authToken = String(process.env.JIRA_MCP_HTTP_AUTH_TOKEN || '').trim();
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const hostHeader = req.headers.host || `${host}:${port}`;
      const requestUrl = new URL(req.url || '/', `http://${hostHeader}`);

      if (requestUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, transport: 'streamable-http' }));
        return;
      }

      if (requestUrl.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      if (!isAuthorizedRequest(req, authToken)) {
        writeJsonRpcError(res, 401, 'Unauthorized');
        return;
      }

      if (!['GET', 'POST', 'DELETE'].includes(method)) {
        res.writeHead(405, { Allow: 'GET, POST, DELETE' });
        res.end();
        return;
      }

      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      const currentSession = sessionId ? sessions.get(String(sessionId)) : undefined;

      if (method === 'POST') {
        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch {
          writeJsonRpcError(res, 400, 'Invalid JSON body', -32700);
          return;
        }

        if (currentSession) {
          setRuntimeConfigFromSnapshot(currentSession.sourcePath, currentSession.snapshot, { log: false });
          await currentSession.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!sessionId && isInitializeRequest(parsedBody)) {
          let sessionSetup;
          try {
            const resolved = resolveSnapshotFromRequestHeaders(req);
            setRuntimeConfigFromSnapshot(resolved.sourcePath, resolved.snapshot);
            const runtime = computeServiceConfigForCurrentRuntime(resolved.sourcePath);
            sessionSetup = { ...resolved, ...runtime };
          } catch (e) {
            writeJsonRpcError(res, 400, e instanceof Error ? e.message : String(e), -32602);
            return;
          }

          const mcpServer = createConfiguredMcpServer(sessionSetup.config, sessionSetup.bitbucketConfig);
          let transport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (createdSessionId) => {
              const normalizedSessionId = String(createdSessionId);
              sessions.set(normalizedSessionId, {
                sessionId: normalizedSessionId,
                transport,
                mcpServer,
                sourcePath: sessionSetup.sourcePath,
                snapshot: sessionSetup.snapshot,
              });
              logger.info('mcp.http.session_initialized', {
                sessionId: normalizedSessionId,
                configSource: sessionSetup.sourcePath,
              });
            },
          });

          transport.onclose = () => {
            const closedSessionId = transport.sessionId ? String(transport.sessionId) : '';
            if (!closedSessionId) return;
            sessions.delete(closedSessionId);
            logger.info('mcp.http.session_closed', { sessionId: closedSessionId });
          };

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        writeJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
        return;
      }

      if (!currentSession) {
        writeJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
        return;
      }

      setRuntimeConfigFromSnapshot(currentSession.sourcePath, currentSession.snapshot, { log: false });
      await currentSession.transport.handleRequest(req, res);
    } catch (error) {
      logger.error('mcp.http.request_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) writeJsonRpcError(res, 500, 'Internal server error', -32603);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('mcp.http.shutdown_started', { signal });
    for (const session of sessions.values()) await closeSession(session, sessions);
    await new Promise((resolve) => httpServer.close(() => resolve()));
    logger.info('mcp.http.shutdown_complete', { signal });
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, resolve);
  });

  logger.info('mcp.server.ready', {
    transport: 'streamable-http',
    host,
    port,
    path,
    auth: authToken ? 'bearer_token' : 'none',
    toolGroups: jiraToolRegistrars.length + 3,
  });
}

async function main() {
  await startHttpServer();
}

main().catch((err) => {
  logger.error('mcp.server.fatal', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
