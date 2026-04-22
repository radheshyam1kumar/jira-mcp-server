import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import {
  DEFAULT_USER_DOC_ID,
  PIPELINE_STAGE_DEFS,
  PIPELINE_STAGE_IDS,
} from '../constants/pipelineStages.js';

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
  const { createdAt, updatedAt, ...rest } = data;
  const stages = Array.isArray(data.stages) ? data.stages : initialStages();
  const prUrls = Array.isArray(data.prUrls)
    ? data.prUrls.map((x) => String(x || '').trim()).filter(Boolean)
    : data.prUrl
      ? [String(data.prUrl).trim()]
      : [];
  return {
    _id: id,
    ...rest,
    issueKey: id,
    stages,
    prUrls,
    prUrl: prUrls[0] || '',
    progress: typeof data.progress === 'number' ? data.progress : computeProgress(stages),
    ...(createdAt !== undefined ? { createdAt: timestampToIso(createdAt) } : {}),
    ...(updatedAt !== undefined ? { updatedAt: timestampToIso(updatedAt) } : {}),
  };
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
  if (payload.stages) {
    payload.progress = computeProgress(payload.stages);
  }
  await ref.set(payload, { merge: true });
  const next = await ref.get();
  return serializeJiraTicket(next.data(), ref.id);
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
