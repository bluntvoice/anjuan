import { db } from '../db.js';
import { createIdentityService } from './identity-service.js';
export const identity = createIdentityService(db);
