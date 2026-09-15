import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { AuditService } from '../audit/audit-service.js';
import { SessionStore } from '../auth/session-store.js';
import { requireUnlockedSession } from './route-helpers.js';

export interface AuditRouteDependencies {
  sessionStore: SessionStore;
  auditService: AuditService;
}

const querySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  eventType: z.string().min(2).max(64).optional(),
  hostId: z.string().min(1).max(128).optional()
}).strict();

export const registerAuditRoutes = async (app: FastifyInstance, dependencies: AuditRouteDependencies): Promise<void> => {
  app.get('/api/audit', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError('AUDIT_METADATA_INVALID');
    reply.send(await dependencies.auditService.list(parsed.data));
  });
};
