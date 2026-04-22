import { Router } from 'express';
import { postPipelineEvent } from '../controllers/jiraTicket.controller.js';
import { requirePipelineInternalSecret } from '../middleware/internalPipelineAuth.js';

const router = Router();

router.use(requirePipelineInternalSecret);
router.post('/jira-pipeline/event', postPipelineEvent);

export default router;
