import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load service account JSON from (first match):
 * 1. FIREBASE_SERVICE_ACCOUNT_PATH — absolute or cwd-relative path to .json
 * 2. FIREBASE_SERVICE_ACCOUNT_JSON — raw JSON string (e.g. in CI secrets)
 * 3. backend/serviceAccountKey.json next to this file
 */
function loadServiceAccount() {
  const fromPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (fromPath) {
    return JSON.parse(readFileSync(resolve(fromPath), 'utf8'));
  }
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    return JSON.parse(inline);
  }
  const local = resolve(__dirname, 'serviceAccountKey.json');
  return JSON.parse(readFileSync(local, 'utf8'));
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
  });
}

const db = admin.firestore();

export { admin, db };
