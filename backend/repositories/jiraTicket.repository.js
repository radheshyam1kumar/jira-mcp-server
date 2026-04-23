import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import {
  DEFAULT_USER_DOC_ID,
  PIPELINE_STAGE_DEFS,
  PIPELINE_STAGE_IDS,
} from '../constants/pipelineStages.js';
import {
  calculatePhaseCost,
  enrichPipelineRunsForApi,
  extractUsage,
  roundUsd,
} from '../utils/llmCost.js';
import { logger } from '../utils/logger.js';
import { collectCodegenModelsFromRuns } from '../utils/codegenModels.js';

const COLLECTION = 'jiraTickets';

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return value;
}

export function normalizeIssueKey(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(t) ? t : null;
}

function initialStages() {
  return PIPELINE_STAGE_DEFS.map((s) => ({
    id: s.id,
    label: s.label,
    status: 'PENDING',
  }));
}

function createNewPipelineRun() {
  return {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    phases: [],
  };
}

function normalizePipelineRuns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    runId: typeof r?.runId === 'string' && r.runId ? r.runId : randomUUID(),
    startedAt: typeof r?.startedAt === 'string' && r.startedAt ? r.startedAt : new Date().toISOString(),
    completedAt: r?.completedAt == null || r.completedAt === '' ? null : String(r.completedAt),
    phases: Array.isArray(r?.phases) ? r.phases : [],
  }));
}

/** Last run index if it is still open (no completedAt), else -1. */
function activeRunIndex(runs) {
  if (!runs.length) return -1;
  const last = runs[runs.length - 1];
  return last.completedAt ? -1 : runs.length - 1;
}

function computeProgress(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return 0;
  const success = stages.filter((s) => s.status === 'SUCCESS').length;
  return Math.min(100, Math.round((success / stages.length) * 100));
}

function allStagesSucceeded(stages) {
  return Array.isArray(stages) && stages.length > 0 && stages.every((s) => s.status === 'SUCCESS');
}

export function serializeJiraTicket(data, id) {
  if (!data) return null;
  const { createdAt, updatedAt, pipelineRuns: storedPipelineRuns, ...rest } = data;
  const stages = Array.isArray(data.stages) ? data.stages : initialStages();
  const prUrls = Array.isArray(data.prUrls)
    ? data.prUrls.map((x) => String(x || '').trim()).filter(Boolean)
    : data.prUrl
      ? [String(data.prUrl).trim()]
      : [];
  const rawRuns = Array.isArray(storedPipelineRuns) ? storedPipelineRuns : [];
  const { runs: pipelineRuns, taskCost } = enrichPipelineRunsForApi(rawRuns);
  const cost = {
    all_runs_usd: taskCost.all_runs_usd,
    total_tokens: taskCost.total_tokens,
    run_count: taskCost.run_count,
  };
  const base = {
    _id: id,
    ...rest,
    issueKey: id,
    stages,
    prUrls,
    prUrl: prUrls[0] || '',
    progress: typeof data.progress === 'number' ? data.progress : computeProgress(stages),
    cost,
    codegenModels: collectCodegenModelsFromRuns(rawRuns),
    ...(createdAt !== undefined ? { createdAt: timestampToIso(createdAt) } : {}),
    ...(updatedAt !== undefined ? { updatedAt: timestampToIso(updatedAt) } : {}),
  };
  if (rawRuns.length > 0) {
    return { ...base, pipelineRuns };
  }
  return base;
}

function mergeStageStatuses(existingStages, stageId, status) {
  const restartFromDevelopment =
    stageId === 'DEVELOPMENT' &&
    status === 'IN_PROGRESS' &&
    Array.isArray(existingStages) &&
    existingStages.length === PIPELINE_STAGE_IDS.length &&
    existingStages
      .slice(PIPELINE_STAGE_IDS.indexOf('DEVELOPMENT') + 1)
      .some((s) => s && typeof s === 'object' && s.status !== 'PENDING');
  const base =
    restartFromDevelopment
      ? initialStages()
      : Array.isArray(existingStages) && existingStages.length === PIPELINE_STAGE_IDS.length
      ? existingStages.map((s) => ({ ...s }))
      : initialStages();
  const idx = PIPELINE_STAGE_IDS.indexOf(stageId);
  if (idx === -1) return { stages: base, changed: false };
  const next = [...base];
  next[idx] = { ...next[idx], status };
  if (status === 'SUCCESS') {
    for (let i = 0; i < idx; i += 1) {
      if (next[i].status !== 'FAILED') next[i] = { ...next[i], status: 'SUCCESS' };
    }
  }
  if (status === 'IN_PROGRESS') {
    for (let i = 0; i < idx; i += 1) {
      if (next[i].status === 'PENDING') next[i] = { ...next[i], status: 'SUCCESS' };
    }
    // Current stage is active again — anything after it must not stay "done" from an old run.
    for (let i = idx + 1; i < next.length; i += 1) {
      next[i] = { ...next[i], status: 'PENDING' };
    }
  }
  if (status === 'FAILED') {
    for (let i = idx + 1; i < next.length; i += 1) {
      next[i] = { ...next[i], status: 'PENDING' };
    }
  }
  return { stages: next, changed: true };
}

function stagesForRetry(existingStages) {
  const base =
    Array.isArray(existingStages) && existingStages.length === PIPELINE_STAGE_IDS.length
      ? existingStages.map((s) => ({ ...s }))
      : initialStages();
  const failedIdx = base.findIndex((s) => s.status === 'FAILED');
  if (failedIdx === -1) return { stages: base, changed: false };
  const next = base.map((s, idx) => {
    if (idx < failedIdx) return s;
    if (idx === failedIdx) return { ...s, status: 'IN_PROGRESS' };
    return { ...s, status: 'PENDING' };
  });
  return { stages: next, changed: true };
}

export async function getTicketByIssueKey(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const snap = await db.collection(COLLECTION).doc(key).get();
  if (!snap.exists) return null;
  return serializeJiraTicket(snap.data(), snap.id);
}

export async function listTicketsForUser(userId, limit = 100) {
  const uid = String(userId);
  const q = await db.collection(COLLECTION).where('userId', '==', uid).limit(limit).get();
  const rows = q.docs.map((d) => serializeJiraTicket(d.data(), d.id));
  rows.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  return rows;
}

export async function ensureTicketDocument(issueKey, userId = DEFAULT_USER_DOC_ID) {
  const key = normalizeIssueKey(issueKey);
  if (!key) throw new Error('Invalid issueKey');
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  const now = FieldValue.serverTimestamp();
  if (!snap.exists) {
    const doc = {
      userId: String(userId),
      summary: '',
      jiraStatus: '',
      descriptionPreview: '',
      repository: '',
      prUrl: '',
      prUrls: [],
      activityLogs: [],
      stages: initialStages(),
      pipelineRuns: [createNewPipelineRun()],
      currentStatus: 'RUNNING',
      currentStatusDescription: '',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc);
    const created = await ref.get();
    return { ticket: serializeJiraTicket(created.data(), ref.id), created: true };
  }
  const cur = snap.data()?.currentStatus;
  const terminal = cur === 'CLOSED' || cur === 'FAILED';
  await ref.set(
    terminal ? { updatedAt: now } : { currentStatus: 'RUNNING', currentStatusDescription: '', updatedAt: now },
    { merge: true },
  );
  const updated = await ref.get();
  return { ticket: serializeJiraTicket(updated.data(), ref.id), created: false };
}

export async function appendActivityLog(issueKey, message) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const line = {
    at: new Date().toISOString(),
    message: String(message).slice(0, 4000),
  };
  await ref.update({
    activityLogs: FieldValue.arrayUnion(line),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const snap = await ref.get();
  return serializeJiraTicket(snap.data(), snap.id);
}

export async function patchTicket(issueKey, patch) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const payload = { ...patch, updatedAt: FieldValue.serverTimestamp() };
  delete payload.issueKey;
  delete payload._id;
  delete payload.createdAt;
  delete payload.pipelineRuns;
  delete payload.cost;
  delete payload.codegenModels;
  if (payload.stages) {
    payload.progress = computeProgress(payload.stages);
  }
  await ref.set(payload, { merge: true });
  const next = await ref.get();
  return serializeJiraTicket(next.data(), ref.id);
}

export async function closeActivePipelineRun(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const runs = normalizePipelineRuns(data.pipelineRuns);
  if (!runs.length) return serializeJiraTicket(data, key);
  const idx = activeRunIndex(runs);
  if (idx === -1) return serializeJiraTicket(data, key);
  const nextRuns = [...runs];
  nextRuns[idx] = { ...nextRuns[idx], completedAt: new Date().toISOString() };
  await ref.update({
    pipelineRuns: nextRuns,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

async function syncPipelineRunWithTerminalStatus(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return;
  const st = snap.data()?.currentStatus;
  if (st === 'CLOSED' || st === 'FAILED') {
    await closeActivePipelineRun(key);
  }
}

export async function startNewPipelineRun(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  let runs = normalizePipelineRuns(data.pipelineRuns);
  if (!runs.length) {
    runs = [createNewPipelineRun()];
  } else {
    const idx = activeRunIndex(runs);
    const nextRuns = [...runs];
    if (idx !== -1) {
      nextRuns[idx] = { ...nextRuns[idx], completedAt: new Date().toISOString() };
    }
    nextRuns.push(createNewPipelineRun());
    runs = nextRuns;
  }
  await ref.update({
    pipelineRuns: runs,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

/**
 * Merge LLM usage into the active pipeline run for a logical phase (multiple calls accumulate).
 * @param {string} issueKey
 * @param {{ phase: string, model?: string, llmResponse?: unknown, usage?: Record<string, unknown> | null }} payload
 */
export async function appendLlmPhaseUsage(issueKey, payload) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const phaseName = String(payload?.phase || '').trim();
  if (!phaseName) {
    throw new Error('appendLlmPhaseUsage: phase is required');
  }
  const ref = db.collection(COLLECTION).doc(key);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() || {};
      let runs = normalizePipelineRuns(data.pipelineRuns);
      let idx = activeRunIndex(runs);
      if (idx === -1) {
        runs = [...runs, createNewPipelineRun()];
        idx = runs.length - 1;
      }
      const current = runs[idx];
      const phases = Array.isArray(current.phases)
        ? current.phases.map((p) => ({
            ...p,
            usage: p?.usage
              ? {
                  prompt_tokens: Number(p.usage.prompt_tokens) || 0,
                  completion_tokens: Number(p.usage.completion_tokens) || 0,
                  total_tokens: Number(p.usage.total_tokens) || 0,
                }
              : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }))
        : [];

      const delta =
        payload.usage != null && typeof payload.usage === 'object'
          ? extractUsage({ usage: payload.usage })
          : extractUsage(payload.llmResponse ?? null);

      const modelName =
        String(payload.model || '').trim() ||
        (() => {
          const existing = phases.find((p) => p && p.phase === phaseName);
          return (existing && existing.model) || 'claude-sonnet-4-6';
        })();

      const pi = phases.findIndex((p) => p && p.phase === phaseName);
      if (pi >= 0) {
        const u0 = phases[pi].usage;
        const mergedUsage = {
          prompt_tokens: (Number(u0.prompt_tokens) || 0) + delta.prompt_tokens,
          completion_tokens: (Number(u0.completion_tokens) || 0) + delta.completion_tokens,
          total_tokens: 0,
        };
        mergedUsage.total_tokens = mergedUsage.prompt_tokens + mergedUsage.completion_tokens;
        phases[pi] = {
          phase: phaseName,
          model: modelName,
          usage: mergedUsage,
          cost_usd: roundUsd(calculatePhaseCost(mergedUsage, modelName)),
        };
      } else {
        const mergedUsage = { ...delta };
        phases.push({
          phase: phaseName,
          model: modelName,
          usage: mergedUsage,
          cost_usd: roundUsd(calculatePhaseCost(mergedUsage, modelName)),
        });
      }

      const nextRuns = [...runs];
      nextRuns[idx] = { ...current, phases };
      tx.update(ref, {
        pipelineRuns: nextRuns,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    logger.error('jiraTicket.appendLlmPhaseUsage_failed', {
      issueKey: key,
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

/**
 * Start a new development cycle on an existing ticket: stages reset so work is "at Development"
 * again (fetch + analyze marked done for this cycle). Preserves prUrls, prUrl, activityLogs,
 * repository, and other metadata — only stages + progress + running status are updated.
 */
export async function resetStagesForNewDevelopmentCycle(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const stages = PIPELINE_STAGE_DEFS.map((def, i) => ({
    id: def.id,
    label: def.label,
    status: i <= 1 ? 'SUCCESS' : i === 2 ? 'IN_PROGRESS' : 'PENDING',
  }));
  const progress = computeProgress(stages);
  await ref.update({
    stages,
    progress,
    currentStatus: 'RUNNING',
    currentStatusDescription: '',
    updatedAt: FieldValue.serverTimestamp(),
  });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

export async function addPrUrl(issueKey, prUrl) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const value = String(prUrl || '').trim().slice(0, 2000);
  if (!value) return getTicketByIssueKey(key);
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const existing = Array.isArray(data.prUrls)
    ? data.prUrls.map((x) => String(x || '').trim()).filter(Boolean)
    : data.prUrl
      ? [String(data.prUrl).trim()]
      : [];
  const nextUrls = [value, ...existing.filter((u) => u !== value)];
  await ref.update({
    prUrl: value,
    prUrls: nextUrls,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

export async function applyStageUpdate(issueKey, stageId, stageStatus, options = {}) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  const { stages, changed } = mergeStageStatuses(data.stages, stageId, stageStatus);
  if (!changed) {
    if (stageStatus === 'SUCCESS' && allStagesSucceeded(stages) && data.currentStatus !== 'CLOSED') {
      await ref.update({
        currentStatus: 'CLOSED',
        currentStatusDescription: String(options.description || 'Pipeline completed successfully.').slice(0, 2000),
        progress: 100,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await syncPipelineRunWithTerminalStatus(key);
      const closed = await ref.get();
      return serializeJiraTicket(closed.data(), closed.id);
    }
    return serializeJiraTicket(data, key);
  }
  const progress = computeProgress(stages);
  const updates = {
    stages,
    progress,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (stageStatus === 'IN_PROGRESS') {
    updates.currentStatus = 'RUNNING';
    updates.currentStatusDescription = '';
  }
  if (stageStatus === 'SUCCESS' && allStagesSucceeded(stages)) {
    updates.currentStatus = 'CLOSED';
    updates.currentStatusDescription = String(options.description || 'Pipeline completed successfully.').slice(0, 2000);
  }
  if (stageStatus === 'FAILED') {
    updates.currentStatus = 'FAILED';
    if (options.description) {
      updates.currentStatusDescription = String(options.description).slice(0, 2000);
    }
  }
  await ref.update(updates);
  await syncPipelineRunWithTerminalStatus(key);
  const next = await ref.get();
  return serializeJiraTicket(next.data(), next.id);
}

export async function markFailed(issueKey, description) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  const stages = Array.isArray(data.stages) ? data.stages.map((s) => ({ ...s })) : initialStages();
  const inProg = stages.findIndex((s) => s.status === 'IN_PROGRESS');
  const failIdx = inProg >= 0 ? inProg : stages.findIndex((s) => s.status === 'PENDING');
  if (failIdx >= 0) stages[failIdx] = { ...stages[failIdx], status: 'FAILED' };
  await ref.update({
    currentStatus: 'FAILED',
    currentStatusDescription: String(description || 'Pipeline failed').slice(0, 2000),
    stages,
    progress: computeProgress(stages),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await syncPipelineRunWithTerminalStatus(key);
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

export async function markBuildClosed(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  const stages = Array.isArray(data.stages) ? [...data.stages] : initialStages();
  const buildIdx = PIPELINE_STAGE_IDS.indexOf('BUILD');
  const next = stages.map((s, i) => (i <= buildIdx ? { ...s, status: 'SUCCESS' } : { ...s }));
  const progress = computeProgress(next);
  const closed = allStagesSucceeded(next);
  await ref.update({
    currentStatus: closed ? 'CLOSED' : 'RUNNING',
    currentStatusDescription: closed
      ? 'Pipeline completed successfully.'
      : 'Build completed successfully. Awaiting deployment.',
    stages: next,
    progress,
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (closed) {
    await syncPipelineRunWithTerminalStatus(key);
  }
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

export async function markDeployStageSuccess(issueKey) {
  return applyStageUpdate(issueKey, 'DEPLOY', 'SUCCESS', {
    description: 'Deployment completed successfully.',
  });
}

export async function resetTicketForRetry(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const current = snap.data() || {};
  const { stages, changed } = stagesForRetry(current.stages);
  const progress = computeProgress(stages);
  await ref.update({
    currentStatus: 'RUNNING',
    currentStatusDescription: changed ? 'Retry requested. Resuming pipeline from failed stage.' : '',
    stages,
    progress,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}

export async function setJiraIssueFields(issueKey, { summary, jiraStatus, descriptionPreview }) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return null;
  const ref = db.collection(COLLECTION).doc(key);
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  if (summary != null) updates.summary = String(summary).slice(0, 500);
  if (jiraStatus != null) updates.jiraStatus = String(jiraStatus).slice(0, 200);
  if (descriptionPreview != null) updates.descriptionPreview = String(descriptionPreview).slice(0, 2000);
  await ref.set(updates, { merge: true });
  const out = await ref.get();
  return serializeJiraTicket(out.data(), out.id);
}
