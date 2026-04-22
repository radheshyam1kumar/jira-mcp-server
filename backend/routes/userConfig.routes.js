import { Router } from 'express';
import { getUserConfig, upsertUserConfig } from '../controllers/userConfig.controller.js';

const router = Router();

router.route('/user-config')
.get(getUserConfig)
.post(upsertUserConfig)
.put(upsertUserConfig);


export default router;
