import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { pickEnv } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Dev / corporate-proxy escape hatch. **Never enable on untrusted networks.**
 */
export function isJiraTlsInsecureMode() {
  return pickEnv('JIRA_TLS_INSECURE') === 'true' || pickEnv('JIRA_ATTACHMENT_TLS_INSECURE') === 'true';
}

function extraCaFilePath() {
  const p = pickEnv('JIRA_EXTRA_CA_FILE') || pickEnv('JIRA_CA_BUNDLE_PATH');
  return p || '';
}

let cachedAgent = null;

/**
 * HTTPS agent for Jira REST, attachment downloads, and outbound link fetchers
 * (Confluence API, Google Docs export, generic HTML, PDF URLs).
 * - Default: Node trust store (includes certs from NODE_EXTRA_CA_CERTS when set).
 * - JIRA_EXTRA_CA_FILE / JIRA_CA_BUNDLE_PATH: PEM file merged with Node's rootCertificates (fixes corporate MITM).
 * - JIRA_TLS_INSECURE / JIRA_ATTACHMENT_TLS_INSECURE=true: disable verification (dev only).
 */
export function getJiraHttpsAgent() {
  if (cachedAgent) {
    return cachedAgent;
  }

  if (isJiraTlsInsecureMode()) {
    logger.warn('jira.tls.insecure', {
      message:
        'TLS certificate verification disabled for Jira (JIRA_TLS_INSECURE or JIRA_ATTACHMENT_TLS_INSECURE). Use only on trusted networks.',
    });
    cachedAgent = new https.Agent({ rejectUnauthorized: false });
    return cachedAgent;
  }

  const caPath = extraCaFilePath();
  if (caPath) {
    try {
      if (!fs.existsSync(caPath)) {
        logger.warn('jira.tls.extra_ca_missing', { path: caPath });
        cachedAgent = new https.Agent();
        return cachedAgent;
      }
      const extra = fs.readFileSync(caPath, 'utf8');
      const ca = [...tls.rootCertificates, extra];
      logger.info('jira.tls.extra_ca_loaded', { path: caPath });
      cachedAgent = new https.Agent({ ca });
      return cachedAgent;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('jira.tls.extra_ca_read_failed', { path: caPath, message: msg });
    }
  }

  cachedAgent = new https.Agent();
  return cachedAgent;
}
