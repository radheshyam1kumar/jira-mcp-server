import axios from 'axios';
import { getJiraHttpsAgent } from './jiraHttpsAgent.js';

let client = null;

/**
 * Shared axios instance: same TLS behavior for Jira API and attachment downloads.
 */
export function getJiraHttp() {
  if (!client) {
    client = axios.create({
      httpsAgent: getJiraHttpsAgent(),
      timeout: 120_000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
  }
  return client;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function formatHttpError(err) {
  if (axios.isAxiosError(err)) {
    const parts = [err.message];
    if (err.cause instanceof Error) {
      parts.push(err.cause.message);
    }
    if (err.code) {
      parts.push(String(err.code));
    }
    if (err.response != null) {
      parts.push(`HTTP ${err.response.status}`);
    }
    return parts.join(' | ');
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
