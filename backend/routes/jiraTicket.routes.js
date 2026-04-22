import { Router } from 'express';
import {
  ensureJiraTicket,
  getJiraTicket,
  listJiraTickets,
  retryJiraTicket,
} from '../controllers/jiraTicket.controller.js';

const router = Router();

router.get('/jira-tickets', listJiraTickets);
router.get('/jira-tickets/:issueKey', getJiraTicket);
router.post('/jira-tickets/ensure', ensureJiraTicket);
router.post('/jira-tickets/:issueKey/retry', retryJiraTicket);

export default router;
