import axios from 'axios';
import { logger } from '../utils/logger.js';


export class JenkinsDeploymentPipeline {
  constructor({ baseUrl, jobPath, username, apiToken, jobPathOverride }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.jobPath = (jobPathOverride || jobPath).replace(/\/+$/, '');
    if (!this.jobPath.startsWith('/')) {
      this.jobPath = `/${this.jobPath}`;
    }
    this.auth = Buffer.from(`${username}:${apiToken}`, 'utf8').toString('base64');
    const authHeader = `Basic ${this.auth}`;

    this.http = axios.create({
      timeout: 120_000,
      maxRedirects: 5,
      validateStatus: () => true,
      beforeRedirect: (options) => {
        if (!options.headers) options.headers = {};
        if (typeof options.headers.set === 'function') {
          options.headers.set('Authorization', authHeader);
        } else {
          options.headers.Authorization = authHeader;
        }
      },
    });
  }

  effectiveJobUrl() {
    return `${this.baseUrl}${this.jobPath}`;
  }

  async getCrumb() {
    const url = `${this.baseUrl}/crumbIssuer/api/json`;
    const res = await this.http.get(url, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.crumb) {
      const msg = res.data?.message || `HTTP ${res.status}`;
      logger.error('jenkins.deploy.crumb_failed', { url, status: res.status });
      throw new Error(`Jenkins CSRF crumb failed: ${msg}`);
    }
    return res.data;
  }

  async triggerBuild(params) {
    const crumb = await this.getCrumb();
    const startTime = Date.now();

    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        body.set(k, String(v));
      }
    }

    const url = `${this.baseUrl}${this.jobPath}/buildWithParameters`;
    logger.info('jenkins.deploy.trigger', { url, params: Object.keys(params) });

    const res = await this.http.post(url, body.toString(), {
      maxRedirects: 0,
      headers: {
        Authorization: `Basic ${this.auth}`,
        [crumb.crumbRequestField]: crumb.crumb,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const queueUrl = res.headers.location || res.headers.Location || null;

    if (res.status !== 200 && res.status !== 201 && res.status !== 302) {
      const snippet = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200);
      logger.error('jenkins.deploy.trigger_failed', { status: res.status, snippet });
      throw new Error(`Jenkins deployment trigger failed: HTTP ${res.status} ${snippet}`);
    }

    return { startTime, queueUrl, status: res.status };
  }

  async getBuilds() {
    const tree = encodeURIComponent('builds[number,url,result,timestamp,actions[parameters[name,value]]]');
    const url = `${this.baseUrl}${this.jobPath}/api/json?tree=${tree}`;
    const res = await this.http.get(url, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jenkins getBuilds failed: HTTP ${res.status}`);
    }
    return Array.isArray(res.data?.builds) ? res.data.builds : [];
  }

  matchBuild(build, params, startTime) {
    if (!build || typeof build.timestamp !== 'number') return false;
    if (build.timestamp < startTime) return false;

    const paramAction = build.actions?.find((a) => a && Array.isArray(a.parameters));
    if (!paramAction) return false;

    const buildParams = Object.fromEntries(paramAction.parameters.map((p) => [p.name, p.value]));

    for (const [key, val] of Object.entries(params)) {
      if (val === undefined || val === null) continue;
      if (String(buildParams[key]) !== String(val)) return false;
    }
    return true;
  }

  async waitForBuild(params, startTime, timeoutMs = 5 * 60 * 1000, pollMs = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const builds = await this.getBuilds();
      const matched = builds.find((b) => this.matchBuild(b, params, startTime));
      if (matched) {
        logger.info('jenkins.deploy.build_matched', { number: matched.number });
        return matched;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Deployment run not found within timeout (no matching parameters after trigger)');
  }

  async waitForCompletion(buildNumber, timeoutMs = 15 * 60 * 1000, pollMs = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const url = `${this.baseUrl}${this.jobPath}/${buildNumber}/api/json`;
      const res = await this.http.get(url, {
        headers: { Authorization: `Basic ${this.auth}` },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Jenkins deployment build API failed: HTTP ${res.status}`);
      }
      const data = res.data;
      if (!data.building) {
        if (data.result !== 'SUCCESS') {
          throw new Error(`Deployment finished with result: ${data.result ?? 'UNKNOWN'}`);
        }
        return data;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Deployment did not complete within timeout');
  }

  async getConsoleLog(buildNumber) {
    const url = `${this.baseUrl}${this.jobPath}/${buildNumber}/consoleText`;
    const res = await this.http.get(url, {
      headers: { Authorization: `Basic ${this.auth}` },
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jenkins deployment console log failed: HTTP ${res.status}`);
    }
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Full flow: trigger → match run → SUCCESS (no S3 extraction; ZIP is an input).
   */
  async run(params, opts = {}) {
    const waitBuildMs = opts.waitForBuildTimeoutMs ?? 5 * 60 * 1000;
    const waitDoneMs = opts.waitForCompletionTimeoutMs ?? 15 * 60 * 1000;

    const { startTime } = await this.triggerBuild(params);
    const build = await this.waitForBuild(params, startTime, waitBuildMs);
    await this.waitForCompletion(build.number, waitDoneMs);

    return {
      buildNumber: build.number,
      buildUrl: build.url,
    };
  }
}
