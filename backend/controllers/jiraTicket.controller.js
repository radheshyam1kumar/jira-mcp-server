import { DEFAULT_USER_DOC_ID } from '../constants/pipelineStages.js';
import * as repo from '../repositories/jiraTicket.repository.js';

/** Fully green pipeline or terminal ticket — a fresh Jira fetch implies a new cycle. */
function shouldResetPipelineForStaleCompletion(existing) {
  if (!existing || !Array.isArray(existing.stages) || existing.stages.length === 0) return false;
  const allSuccess = existing.stages.every((s) => s && s.status === 'SUCCESS');
  return allSuccess || existing.currentStatus === 'CLOSED';
}

function toListShape(t) {
  if (!t) return t;
  const { activityLogs, pipelineRuns, ...rest } = t;
  return {
    ...rest,
    activityLogCount: Array.isArray(activityLogs) ? activityLogs.length : 0,
    pipelineRunCount:
      typeof t.cost?.run_count === 'number'
        ? t.cost.run_count
        : Array.isArray(pipelineRuns)
          ? pipelineRuns.length
          : 0,
  };
}

export async function listJiraTickets(req, res, next) {
  try {
    const userId = String(req.query.userId || DEFAULT_USER_DOC_ID);
    const tickets = await repo.listTicketsForUser(userId);
    res.json(tickets.map(toListShape));
  } catch (err) {
    next(err);
  }
}

export async function getJiraTicket(req, res, next) {
  try {
    const key = repo.normalizeIssueKey(req.params.issueKey);
    if (!key) {
      res.status(400).json({ message: 'Invalid issue key.' });
      return;
    }
    const t = await repo.getTicketByIssueKey(key);
    if (!t) {
      res.status(404).json({ message: 'Ticket not found.' });
      return;
    }
    res.json(t);
  } catch (err) {
    next(err);
  }
}

export async function retryJiraTicket(req, res, next) {
  try {
    const key = repo.normalizeIssueKey(req.params.issueKey);
    if (!key) {
      res.status(400).json({ message: 'Invalid issue key.' });
      return;
    }
    const t = await repo.resetTicketForRetry(key);
    if (!t) {
      res.status(404).json({ message: 'Ticket not found.' });
      return;
    }
    await repo.appendActivityLog(key, 'Pipeline retry requested — resuming from failed stage.');
    const out = await repo.getTicketByIssueKey(key);
    res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function ensureJiraTicket(req, res, next) {
  try {
    const key = repo.normalizeIssueKey(req.body?.issueKey);
    if (!key) {
      res.status(400).json({ message: 'issueKey is required (e.g. IPG-1096).' });
      return;
    }
    const userId = String(req.body?.userId || DEFAULT_USER_DOC_ID);
    const { ticket, created } = await repo.ensureTicketDocument(key, userId);
    if (created) {
      await repo.appendActivityLog(key, 'Job registered for this Jira ticket.');
    }
    const out = await repo.getTicketByIssueKey(key);
    res.status(created ? 201 : 200).json(out);
  } catch (err) {
    next(err);
  }
}

export async function postPipelineEvent(req, res, next) {
  try {
    const body = req.body || {};
    const { type } = body;
    const key = repo.normalizeIssueKey(body.issueKey);
    if (!key) {
      res.status(400).json({ message: 'issueKey is required.' });
      return;
    }

    let out;
    switch (type) {
      case 'ENSURE': {
        const { ticket } = await repo.ensureTicketDocument(key);
        out = ticket;
        break;
      }
      case 'LOG':
        out = await repo.appendActivityLog(key, body.message || '');
        break;
      case 'STAGE':
        out = await repo.applyStageUpdate(key, body.stageId, body.stageStatus, {
          description: body.description,
        });
        break;
      case 'BEGIN_NEW_DEV_CYCLE': {
        await repo.ensureTicketDocument(key);
        await repo.appendActivityLog(
          key,
          'New development cycle — pipeline reset to Development (PR history and logs preserved).',
        );
        await repo.resetStagesForNewDevelopmentCycle(key);
        out = await repo.startNewPipelineRun(key);
        break;
      }
      case 'JIRA_FETCHED': {
        await repo.ensureTicketDocument(key);
        const snapshot = await repo.getTicketByIssueKey(key);
        if (snapshot && shouldResetPipelineForStaleCompletion(snapshot)) {
          await repo.appendActivityLog(
            key,
            'Jira refreshed while pipeline was fully complete — resetting stages for a new cycle (PR history and logs preserved).',
          );
          await repo.resetStagesForNewDevelopmentCycle(key);
          await repo.startNewPipelineRun(key);
        }
        await repo.appendActivityLog(key, 'Jira ticket metadata loaded.');
        await repo.setJiraIssueFields(key, {
          summary: body.summary,
          jiraStatus: body.jiraStatus,
          descriptionPreview: body.descriptionPreview,
        });
        await repo.applyStageUpdate(key, 'FETCH_JIRA', 'SUCCESS');
        out = await repo.applyStageUpdate(key, 'ANALYZE_JIRA', 'SUCCESS');
        await repo.patchTicket(key, { currentStatus: 'RUNNING', currentStatusDescription: '' });
        out = await repo.getTicketByIssueKey(key);
        break;
      }
      case 'JIRA_FETCH_FAILED': {
        await repo.ensureTicketDocument(key);
        await repo.appendActivityLog(key, body.message || 'Failed to fetch Jira ticket.');
        out = await repo.applyStageUpdate(key, 'FETCH_JIRA', 'FAILED', {
          description: body.description || body.message || 'Jira fetch failed',
        });
        break;
      }
      case 'SET_PR':
        await repo.ensureTicketDocument(key);
        await repo.addPrUrl(key, body.prUrl);
        out = await repo.applyStageUpdate(key, 'RAISE_PR', 'SUCCESS');
        break;
      case 'SET_REPOSITORY':
        await repo.ensureTicketDocument(key);
        out = await repo.patchTicket(key, { repository: String(body.repository || '').slice(0, 300) });
        break;
      case 'FAIL':
        out = await repo.markFailed(key, body.description || body.message || 'Pipeline failed');
        break;
      case 'BUILD_SUCCESS':
        await repo.markBuildClosed(key);
        await repo.appendActivityLog(key, 'Jenkins build completed successfully.');
        out = await repo.getTicketByIssueKey(key);
        break;
      case 'DEPLOY_SUCCESS':
        out = await repo.markDeployStageSuccess(key);
        if (out) {
          await repo.appendActivityLog(key, 'Deployment completed successfully.');
          out = await repo.getTicketByIssueKey(key);
        }
        break;
      case 'LLM_USAGE': {
        await repo.ensureTicketDocument(key);
        const phase = String(body.phase || '').trim();
        if (!phase) {
          res.status(400).json({ message: 'phase is required (e.g. implement, plan).' });
          return;
        }
        const model = String(body.model || 'claude-sonnet-4-6').trim();
        try {
          out = await repo.appendLlmPhaseUsage(key, {
            phase,
            model,
            llmResponse: body.llmResponse ?? body.response ?? null,
            usage: body.usage ?? null,
          });
        } catch (e) {
          next(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        break;
      }
      default:
        res.status(400).json({ message: `Unknown event type: ${type}` });
        return;
    }

    if (!out) {
      res.status(404).json({ message: 'Ticket not found for this operation.' });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
}
