import { z } from 'zod';

/**
 * Canonical user config shape (formerly `models/userConfig.model.js` / Mongoose).
 * All writes are merged with the latest stored document, then validated with this schema.
 */

const buildParamsSchema = z.object({
  SERVICE_NAME: z.string().default(''),
  REPO_NAME: z.string().default(''),
  Branch: z.string().default(''),
  Env: z.string().default(''),
  build_type: z.string().default(''),
  release: z.string().default(''),
});

const buildSchema = z.object({
  params: buildParamsSchema.default({}),
  JENKINS_BUILD_BASE_URL: z.string().default(''),
  JENKINS_BUILD_JOB_PATH: z.string().default(''),
  JENKINS_BUILD_USERNAME: z.string().default(''),
  JENKINS_BUILD_API_TOKEN: z.string().default(''),
  SAMPLE_FILE_URL: z.string().default(''),
  requiredParams: z.array(z.string()).default([]),
});

const deploySchema = z.object({
  params: z.record(z.string(), z.string()).default({}),
  JENKINS_DEPLOYMENT_BASE_URL: z.string().default(''),
  JENKINS_DEPLOYMENT_JOB_PATH: z.string().default(''),
  JENKINS_DEPLOYMENT_USERNAME: z.string().default(''),
  JENKINS_DEPLOYMENT_API_TOKEN: z.string().default(''),
  SAMPLE_FILE_URL: z.string().default(''),
  requiredParams: z.array(z.string()).default([]),
});

/** Matches Mongoose `RepoConfigSchema` with `strict: false` — extra keys on a repo entry are kept. */
const repoConfigSchema = z
  .object({
    build: buildSchema.default({}),
    deploy: deploySchema.default({}),
  })
  .passthrough();

const jiraEnvSchema = z.object({
  JIRA_DOMAIN: z.string().default(''),
  JIRA_EMAIL: z.string().default(''),
  JIRA_API_TOKEN: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REFRESH_TOKEN: z.string().default(''),
  BITBUCKET_USERNAME: z.string().default(''),
  BITBUCKET_API_TOKEN: z.string().default(''),
  BITBUCKET_WORKSPACE: z.string().default(''),
  BITBUCKET_REPO: z.string().default('ump2-ui'),
  JIRA_TLS_INSECURE: z.string().default('true'),
});

const jiraSchema = z.object({
  env: jiraEnvSchema.default({}),
  reposConfig: z.record(z.string(), repoConfigSchema).default({}),
});

export const UserConfigSchema = z
  .object({
    jira: jiraSchema.default({ env: {}, reposConfig: {} }),
    user_email: z.string().min(1, 'user_email is required'),
  })
  .strict();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `source` onto `target` (Mongoose-style document merge). Arrays are replaced, not concatenated.
 */
export function deepMergeUserConfig(target, source) {
  if (!isPlainObject(source)) return source;
  const out = { ...(isPlainObject(target) ? target : {}) };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(out[key])) {
      out[key] = deepMergeUserConfig(out[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * Strip API / Firestore metadata before schema parse.
 */
export function stripUserConfigMeta(doc) {
  if (!doc || typeof doc !== 'object') return {};
  const { _id, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

/**
 * Merge stored config with request body and validate to the canonical model.
 * @param {object | null} existingSerialized — from Firestore (may include `_id`, timestamps)
 * @param {object} body — request JSON
 * @returns {{ success: true, data: object } | { success: false, error: z.ZodError }}
 */
export function mergeAndValidateUserConfig(existingSerialized, body) {
  const base = stripUserConfigMeta(existingSerialized ?? {});
  const merged = deepMergeUserConfig(base, body);
  const parsed = UserConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }
  return { success: true, data: parsed.data };
}

/**
 * Validate/normalize a full stored document (e.g. after read). Does not include timestamps.
 */
export function parseStoredUserConfigCore(doc) {
  const core = stripUserConfigMeta(doc);
  return UserConfigSchema.safeParse(core);
}
