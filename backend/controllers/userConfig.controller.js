import {
  getLatestUserConfig,
  upsertUserConfigDocument,
} from '../repositories/userConfig.repository.js';
import {
  mergeAndValidateUserConfig,
  parseStoredUserConfigCore,
} from '../schemas/userConfig.schema.js';

export async function getUserConfig(_req, res) {
  try {
    const raw = await getLatestUserConfig();
    if (!raw) {
      res.status(200).json(null);
      return;
    }
    const parsed = parseStoredUserConfigCore(raw);
    if (!parsed.success) {
      res.status(500).json({
        message: 'Stored user config does not match schema',
        issues: parsed.error.flatten(),
      });
      return;
    }
    const { createdAt, updatedAt, _id } = raw;
    res.status(200).json({
      _id,
      ...parsed.data,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  } catch (error) {
    res.status(500).json({
      message: 'Failed to fetch user config',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function upsertUserConfig(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ message: 'Request body must be an object' });
      return;
    }

    const existing = await getLatestUserConfig();
    const result = mergeAndValidateUserConfig(existing, req.body);
    if (!result.success) {
      res.status(400).json({
        message: 'Invalid user config (schema validation failed)',
        issues: result.error.flatten(),
      });
      return;
    }

    const config = await upsertUserConfigDocument(result.data);
    res.status(200).json(config);
  } catch (error) {
    res.status(500).json({
      message: 'Failed to save user config',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
