import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';

const COLLECTION = 'userConfigs';
const DOC_ID = 'default';

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return value;
}

function serializeUserConfig(data) {
  if (!data) return null;
  const { createdAt, updatedAt, ...rest } = data;
  return {
    _id: DOC_ID,
    ...rest,
    ...(createdAt !== undefined ? { createdAt: timestampToIso(createdAt) } : {}),
    ...(updatedAt !== undefined ? { updatedAt: timestampToIso(updatedAt) } : {}),
  };
}

export async function getLatestUserConfig() {
  const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
  if (!snap.exists) return null;
  return serializeUserConfig(snap.data());
}

export async function upsertUserConfigDocument(body) {
  const ref = db.collection(COLLECTION).doc(DOC_ID);
  const snap = await ref.get();
  const payload = { ...body };
  delete payload._id;
  delete payload.createdAt;
  delete payload.updatedAt;

  payload.updatedAt = FieldValue.serverTimestamp();
  if (!snap.exists) {
    payload.createdAt = FieldValue.serverTimestamp();
  }

  await ref.set(payload, { merge: true });
  const updated = await ref.get();
  return serializeUserConfig(updated.data());
}
