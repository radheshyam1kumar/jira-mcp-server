#!/usr/bin/env node
/**
 * Cursor hook: afterAgentResponse → pipeline LLM_USAGE (estimated tokens & cost).
 *
 * Cursor does not expose real API usage in hooks. This script approximates:
 *   - completion: ~4 UTF-8 bytes per token on assistant `text`
 *   - prompt: transcript byte growth since last hook run, minus completion estimate
 *
 * Env (same as MCP server; hook inherits Cursor process env if configured):
 *   PIPELINE_API_BASE_URL  default http://127.0.0.1:4001
 *   PIPELINE_INTERNAL_SECRET  optional, sent as x-pipeline-secret
 *   PIPELINE_USAGE_PHASE  default cursor_agent
 *   PIPELINE_AUTO_USAGE  set to 0 to disable without removing the hook
 *
 * Issue key: last match of [A-Z][A-Z0-9]+-\\d+ in transcript (or in assistant text).
 * State: os.tmpdir()/cursor-jira-pipeline-usage/<sha256(workspace)>/<conversation_id>.json
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function hashDir(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
}

function estimateTokensFromUtf8Bytes(bytes) {
  if (!bytes || bytes < 1) return 0;
  return Math.max(1, Math.ceil(bytes / 4));
}

function lastIssueKeyFromString(s) {
  if (!s) return null;
  const re = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  let last = null;
  let m;
  while ((m = re.exec(s)) !== null) last = m[1];
  return last;
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function secretHeaders() {
  const base = String(process.env.PIPELINE_API_BASE_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');
  const secret = String(process.env.PIPELINE_INTERNAL_SECRET || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (secret) h['x-pipeline-secret'] = secret;
  return { base, headers: h };
}

async function postEvent(base, headers, body) {
  const url = `${base}/api/internal/jira-pipeline/event`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`pipeline ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

async function transcriptByteLength(p) {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

async function readTranscriptTailForKeys(transcriptPath, maxBytes = 400_000) {
  try {
    const st = await fsp.stat(transcriptPath);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await fsp.open(transcriptPath, 'r');
    try {
      const len = Math.min(maxBytes, st.size - start);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

function statePath(workspaceRoot, conversationId) {
  const dir = path.join(os.tmpdir(), 'cursor-jira-pipeline-usage', hashDir(workspaceRoot));
  return path.join(dir, `${encodeURIComponent(conversationId)}.json`);
}

async function main() {
  if (String(process.env.PIPELINE_AUTO_USAGE || '1').trim() === '0') {
    process.exit(0);
  }

  const input = await readStdinJson();
  const text = typeof input.text === 'string' ? input.text : '';
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const rawModel = typeof input.model === 'string' && input.model ? input.model : 'claude-sonnet-4-6';
  /** Map Cursor composer model id to a key in backend MODEL_PRICING so cost is non-zero. */
  const model = (() => {
    const m = rawModel.toLowerCase();
    if (m.includes('opus')) return 'claude-opus-4-6';
    return 'claude-sonnet-4-6';
  })();
  const conversationId = typeof input.conversation_id === 'string' ? input.conversation_id : 'default';
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const workspaceRoot = roots[0] || process.cwd();

  const { base, headers } = secretHeaders();
  if (!base) process.exit(0);

  let issueKey = lastIssueKeyFromString(text);
  if (!issueKey && transcriptPath) {
    const tail = await readTranscriptTailForKeys(transcriptPath);
    issueKey = lastIssueKeyFromString(tail);
  }
  if (!issueKey) {
    process.stderr.write('[cursor-hook-pipeline] No Jira issue key in transcript/response; skip.\n');
    process.exit(0);
  }

  const completionBytes = Buffer.byteLength(text, 'utf8');
  const completionTokens = estimateTokensFromUtf8Bytes(completionBytes);

  const currentTranscriptBytes = transcriptPath ? await transcriptByteLength(transcriptPath) : 0;
  const sp = statePath(workspaceRoot, conversationId);
  await fsp.mkdir(path.dirname(sp), { recursive: true });

  let prevBytes = 0;
  try {
    const raw = await fsp.readFile(sp, 'utf8');
    const j = JSON.parse(raw);
    if (typeof j.lastTranscriptBytes === 'number') prevBytes = j.lastTranscriptBytes;
  } catch {
    prevBytes = 0;
  }

  const growth = Math.max(0, currentTranscriptBytes - prevBytes);
  const growthAsTokens = estimateTokensFromUtf8Bytes(growth);
  let promptTokens = Math.max(0, growthAsTokens - completionTokens);
  if (!transcriptPath && promptTokens === 0 && completionTokens > 0) {
    promptTokens = Math.max(0, Math.floor(completionTokens * 0.35));
  }

  await fsp.writeFile(sp, JSON.stringify({ lastTranscriptBytes: currentTranscriptBytes, updatedAt: Date.now() }), 'utf8');

  const phase = String(process.env.PIPELINE_USAGE_PHASE || 'cursor_agent').trim() || 'cursor_agent';

  try {
    await postEvent(base, headers, {
      type: 'ENSURE',
      issueKey,
    });
    await postEvent(base, headers, {
      type: 'LLM_USAGE',
      issueKey,
      phase,
      model,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
    });
    process.stderr.write(
      `[cursor-hook-pipeline] ${issueKey} LLM_USAGE phase=${phase} model=${model} est in=${promptTokens} out=${completionTokens}\n`,
    );
  } catch (e) {
    process.stderr.write(`[cursor-hook-pipeline] ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[cursor-hook-pipeline] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(0);
});
