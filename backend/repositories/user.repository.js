import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { DEFAULT_USER_DOC_ID, DEFAULT_USER_EMAIL } from '../constants/pipelineStages.js';

const COLLECTION = 'users';

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return value;
}

export function serializeUser(data, id) {
  if (!data) return null;
  const { createdAt, updatedAt, ...rest } = data;
  return {
    _id: id,
    ...rest,
    ...(createdAt !== undefined ? { createdAt: timestampToIso(createdAt) } : {}),
    ...(updatedAt !== undefined ? { updatedAt: timestampToIso(updatedAt) } : {}),
  };
}

export async function getUserById(userId) {
  const snap = await db.collection(COLLECTION).doc(String(userId)).get();
  if (!snap.exists) return null;
  return serializeUser(snap.data(), snap.id);
}

export async function getUserByEmail(email) {
  const q = await db.collection(COLLECTION).where('email', '==', String(email).trim().toLowerCase()).limit(1).get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return serializeUser(doc.data(), doc.id);
}

export async function ensureDefaultPipelineUser() {
  const ref = db.collection(COLLECTION).doc(DEFAULT_USER_DOC_ID);
  const snap = await ref.get();
  const email = DEFAULT_USER_EMAIL.toLowerCase();
  if (!snap.exists) {
    await ref.set({
      email,
      displayName: 'Default pipeline user',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const created = await ref.get();
    return serializeUser(created.data(), ref.id);
  }
  const data = snap.data();
  if (data?.email !== email) {
    await ref.set({ email, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const updated = await ref.get();
    return serializeUser(updated.data(), ref.id);
  }
  return serializeUser(data, ref.id);
}
