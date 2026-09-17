import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { hostCredentialSchema } from '../../shared/validation.js';
import type { ImportApplyRequest, ImportFormat, ImportSourceFile } from '../../shared/import/types.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository, type OwnerIdProvider, resolveOwnerId } from '../db/repositories.js';
import { SshImportService } from '../workspace/ssh-import-service.js';
import { requireUnlockedSession } from './route-helpers.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

export interface SshImportRouteDependencies {
  ownerId: OwnerIdProvider;
  sessionStore: SessionStore;
  auditRepository: AuditRepository;
  sshImportService: SshImportService;
  syncCoordinator?: SyncCoordinatorPort;
}

const applySchema = z.object({
  previewId: z.string().min(1).max(128),
  selectedSourceIds: z.array(z.string().min(1).max(512)).max(10_000),
  conflictPolicy: z.enum(['skip', 'create', 'replace']),
  credentials: z.array(z.object({ sourceId: z.string().min(1).max(512), credential: hostCredentialSchema }).strict()).max(10_000).optional()
}).strict();

const exportQuerySchema = z.object({
  includePasswords: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  confirmPasswordExport: z.enum(['true', 'false']).transform((value) => value === 'true').optional()
}).strict();

type ParsedApplyRequest = ImportApplyRequest & { previewId: string };

const readMultipart = async (request: FastifyRequest): Promise<{ files: ImportSourceFile[]; formatHint?: ImportFormat }> => {
  const multipartRequest = request as FastifyRequest & {
    isMultipart?: () => boolean;
    parts?: () => AsyncIterable<{
      type: 'file' | 'field';
      fieldname: string;
      filename?: string;
      value?: string;
      file?: AsyncIterable<Uint8Array>;
    }>;
  };
  if (!multipartRequest.isMultipart?.() || !multipartRequest.parts) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  const files: ImportSourceFile[] = [];
  let totalSize = 0;
  let formatHint: ImportFormat | undefined;
  for await (const part of multipartRequest.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'format' && part.value) {
        const candidate = part.value as ImportFormat;
        if (!['openssh-config', 'ssh-csv', 'mobaxterm', 'xshell', 'securecrt'].includes(candidate)) throw new AppError('IMPORT_FORMAT_UNSUPPORTED');
        formatHint = candidate;
      }
      continue;
    }
    if (!part.file || files.length >= 32) throw new AppError('IMPORT_RECORD_INVALID');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.byteLength;
      totalSize += chunk.byteLength;
      if (size > 8 * 1024 * 1024 || totalSize > 32 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE');
      chunks.push(chunk);
    }
    const filename = (part.filename ?? 'upload').split(/[\\/]/u).at(-1)?.replace(/[\r\n"\0]/gu, '_') || 'upload';
    files.push({ filename, content: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) });
  }
  if (files.length === 0) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return { files, ...(formatHint === undefined ? {} : { formatHint }) };
};

const parseApplyBody = (body: unknown): ParsedApplyRequest => {
  const parsed = applySchema.safeParse(body);
  if (!parsed.success) throw new AppError('IMPORT_APPLY_INVALID');
  return parsed.data;
};

export const registerSshImportRoutes = async (app: FastifyInstance, dependencies: SshImportRouteDependencies): Promise<void> => {
  app.get('/api/import/formats', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(dependencies.sshImportService.listFormats());
  });

  app.post('/api/import/preview', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const multipart = await readMultipart(request);
    const preview = await dependencies.sshImportService.preview(multipart.files, multipart.formatHint);
    dependencies.auditRepository.insert({ eventType: 'ssh_import_previewed', requestId: request.id, metadata: { targetCount: preview.connectionCount } });
    reply.send(preview);
  });

  app.post('/api/import/apply', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseApplyBody(request.body);
    const result = await dependencies.sshImportService.apply(session.record.vaultKey, body.previewId, body);
    dependencies.auditRepository.insert({ eventType: 'ssh_import_applied', requestId: request.id, metadata: { targetCount: body.selectedSourceIds.length, successCount: result.importedHosts } });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, resolveOwnerId(dependencies.ownerId));
    reply.send(result);
  });

  app.get('/api/export/openssh', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const text = await dependencies.sshImportService.exportOpenSsh(session.record.vaultKey);
    reply.type('text/plain; charset=utf-8').header('content-disposition', 'attachment; filename="ssh-config"').send(text);
  });

  app.get('/api/export/csv', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const parsed = exportQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError('IMPORT_APPLY_INVALID');
    const text = await dependencies.sshImportService.exportCsv(session.record.vaultKey, parsed.data);
    reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="ssh-connections.csv"').send(text);
  });
};
