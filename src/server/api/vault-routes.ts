import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../shared/errors.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository } from '../db/repositories.js';
import { VaultBundleService, type ImportResolution } from '../workspace/vault-bundle-service.js';
import { requireUnlockedSession } from './route-helpers.js';

export interface VaultRouteDependencies {
  ownerId: string;
  vaultBundleService: VaultBundleService;
  sessionStore: SessionStore;
  auditRepository: AuditRepository;
}

const exportSchema = z.object({ exportPassword: z.string().min(1).max(4096) }).strict();
const previewSchema = z.object({ exportPassword: z.string().min(1).max(4096), bundle: z.string().min(1).max(64 * 1024 * 1024) }).strict();
const applySchema = z.object({
  previewId: z.string().min(1).max(128),
  resolution: z.object({ hostConflicts: z.enum(['skip', 'replace']), groupConflicts: z.enum(['reuse', 'replace']) }).strict()
}).strict();

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError('VAULT_BUNDLE_INVALID');
  return parsed.data;
};

export const registerVaultRoutes = async (app: FastifyInstance, dependencies: VaultRouteDependencies): Promise<void> => {
  app.post('/api/vault/export', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseBody(exportSchema, request.body);
    const bundle = await dependencies.vaultBundleService.export(session.record.vaultKey, body.exportPassword);
    dependencies.auditRepository.insert({ eventType: 'vault_exported', requestId: request.id });
    reply.send({ bundle });
  });

  app.post('/api/vault/import/preview', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseBody(previewSchema, request.body);
    const preview = await dependencies.vaultBundleService.previewImport(session.record.vaultKey, body.exportPassword, body.bundle);
    dependencies.auditRepository.insert({ eventType: 'vault_import_previewed', requestId: request.id });
    reply.send(preview);
  });

  app.post('/api/vault/import/apply', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseBody(applySchema, request.body);
    const result = await dependencies.vaultBundleService.applyImport(session.record.vaultKey, body.previewId, body.resolution as ImportResolution);
    dependencies.auditRepository.insert({ eventType: 'vault_import_applied', requestId: request.id });
    reply.send(result);
  });
};
