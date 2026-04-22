/**
 * When PIPELINE_INTERNAL_SECRET is set, internal MCP → API routes require the same value
 * in `x-pipeline-secret` or `Authorization: Bearer <secret>`.
 * When unset (local dev), requests are allowed.
 */
export function requirePipelineInternalSecret(req, res, next) {
  const expected = String(process.env.PIPELINE_INTERNAL_SECRET || '').trim();
  if (!expected) return next();
  const header =
    req.headers['x-pipeline-secret'] || req.headers['x-internal-secret'] || req.headers['x-pipeline-internal-secret'];
  const h = Array.isArray(header) ? header[0] : header;
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const token = String(h || bearer || '').trim();
  if (token !== expected) {
    return res.status(403).json({ message: 'Invalid or missing pipeline secret.' });
  }
  return next();
}
