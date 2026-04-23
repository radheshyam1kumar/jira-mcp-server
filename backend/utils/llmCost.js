/**
 * LLM usage extraction and USD cost helpers for Anthropic-style responses.
 * @module
 */

import { getModelRates } from '../config/modelPricing.js';
import { logger } from './logger.js';

/** One-time full JSON sample when LOG_LLM_RESPONSE_ONCE=1 (debugging SDK shapes). */
let loggedFullLlmResponse = false;

/**
 * Extract token counts from a Claude / Anthropic Messages API response (or plain usage object).
 * Missing usage → zeros (backward compatible).
 * @param {unknown} response — SDK result, HTTP JSON, or `{ usage: { input_tokens, output_tokens } }`
 * @returns {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }}
 */
export function extractUsage(response) {
  let body = response;
  if (body != null && typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (body == null || typeof body !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  const usage =
    body.usage ||
    body.message?.usage ||
    body.response?.usage ||
    body.body?.usage ||
    body.data?.usage ||
    null;

  const rawIn = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const rawOut = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const prompt_tokens =
    Number.isFinite(Number(rawIn)) && Number(rawIn) >= 0 ? Math.floor(Number(rawIn)) : 0;
  const completion_tokens =
    Number.isFinite(Number(rawOut)) && Number(rawOut) >= 0 ? Math.floor(Number(rawOut)) : 0;

  if (
    prompt_tokens === 0 &&
    completion_tokens === 0 &&
    Object.keys(body).length > 0
  ) {
    logger.debug('llm.usage.missing_or_zero', {
      topLevelKeys: Object.keys(body).slice(0, 40),
      hasUsageKey: 'usage' in body,
    });
  }

  if (
    !loggedFullLlmResponse &&
    String(process.env.LOG_LLM_RESPONSE_ONCE || '').trim() === '1'
  ) {
    loggedFullLlmResponse = true;
    try {
      const serialized = JSON.stringify(body);
      logger.info('llm.usage.full_response_sample_once', {
        length: serialized.length,
        body: serialized.length > 64_000 ? `${serialized.slice(0, 64_000)}…(truncated)` : serialized,
      });
    } catch (e) {
      logger.warn('llm.usage.full_response_sample_once_failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

/**
 * Phase cost in USD for the given normalized usage and model id.
 * @param {{ prompt_tokens?: number, completion_tokens?: number }} usage
 * @param {string} model
 * @returns {number}
 */
export function calculatePhaseCost(usage, model) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const rates = getModelRates(String(model || ''));
  if (!rates) {
    logger.warn('llm.cost.unknown_model', { model: String(model || '') });
    return 0;
  }
  const p = Number(u.prompt_tokens) || 0;
  const c = Number(u.completion_tokens) || 0;
  if (p < 0 || c < 0) return 0;
  return p * rates.input + c * rates.output;
}

/** @param {Array<{ cost_usd?: number }>} phases */
export function calculateRunCost(phases) {
  if (!Array.isArray(phases)) return 0;
  return phases.reduce((sum, ph) => sum + (Number.isFinite(Number(ph?.cost_usd)) ? Number(ph.cost_usd) : 0), 0);
}

function sumRunTokens(phases) {
  if (!Array.isArray(phases)) return 0;
  return phases.reduce((sum, ph) => {
    const t = ph?.usage?.total_tokens;
    return sum + (Number.isFinite(Number(t)) ? Number(t) : 0);
  }, 0);
}

/** @param {Array<{ phases?: unknown[] }>} runs */
export function calculateTaskCost(runs) {
  if (!Array.isArray(runs)) return 0;
  return runs.reduce((sum, r) => sum + calculateRunCost(r.phases), 0);
}

export function roundUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1_000_000) / 1_000_000;
}

/**
 * Enrich persisted runs for API: each run gets `cost` with current_run_usd, all_runs_usd (task total), total_tokens (run).
 * @param {Array<{ phases?: unknown[], completedAt?: string | null, runId?: string }>} runsRaw
 */
export function enrichPipelineRunsForApi(runsRaw) {
  const runs = Array.isArray(runsRaw) ? runsRaw : [];
  const taskUsd = roundUsd(calculateTaskCost(runs));
  const taskTokens = runs.reduce((s, r) => s + sumRunTokens(r.phases), 0);

  const enriched = runs.map((run) => {
    const phases = Array.isArray(run.phases) ? run.phases : [];
    const current_run_usd = roundUsd(calculateRunCost(phases));
    const total_tokens = sumRunTokens(phases);
    return {
      ...run,
      phases,
      cost: {
        current_run_usd,
        all_runs_usd: taskUsd,
        total_tokens,
      },
    };
  });

  return {
    runs: enriched,
    taskCost: {
      all_runs_usd: taskUsd,
      total_tokens: taskTokens,
      run_count: runs.length,
    },
  };
}
