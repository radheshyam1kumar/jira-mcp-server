/**
 * Claude Messages API pricing: USD **per token** (vendor docs quote per 1K; we divide here).
 * cost = prompt_tokens * input + completion_tokens * output
 */
export const MODEL_PRICING = {
  'claude-sonnet-4-6': {
    input: 0.003 / 1000,
    output: 0.015 / 1000,
  },
  'claude-opus-4-6': {
    input: 0.015 / 1000,
    output: 0.075 / 1000,
  },
};

const MODEL_ALIASES = {
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
};

/** @param {string} model @returns {{ input: number, output: number } | null} */
export function getModelRates(model) {
  if (model == null || typeof model !== 'string') return null;
  const key = model.trim();
  if (!key) return null;
  const resolved = MODEL_ALIASES[key] || key;
  return MODEL_PRICING[resolved] ?? null;
}
