import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditRepository } from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { AuditService } from '../../../src/server/audit/audit-service.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const makeService = (ownerId = 'owner-a') => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  return { database, service: new AuditService(new AuditRepository(database, ownerId)) };
};

describe('AuditService', () => {
  it('keeps structured summaries and rejects secret-bearing or arbitrary metadata', async () => {
    const { service } = makeService();
    const event = await service.record({
      eventType: 'command_run_summary',
      requestId: 'req-1',
      metadata: { runId: 'run-1', targetCount: 2, successCount: 1, failureCount: 1, durationMs: 1200 }
    });
    expect(event.metadata).toEqual({ runId: 'run-1', targetCount: 2, successCount: 1, failureCount: 1, durationMs: 1200 });
    expect(JSON.stringify(event)).not.toContain('password');
    await expect(service.record({ eventType: 'unsafe', requestId: 'req-2', metadata: { password: 'do-not-store' } })).rejects.toMatchObject({ code: 'AUDIT_METADATA_INVALID' });
    await expect(service.record({ eventType: 'unsafe', requestId: 'req-3', metadata: { content: 'raw-file-content' } })).rejects.toMatchObject({ code: 'AUDIT_METADATA_INVALID' });
  });

  it('paginates newest-first and applies event and host filters within the repository owner', async () => {
    const { service } = makeService();
    await service.record({ eventType: 'connection_succeeded', requestId: 'req-1', hostId: null });
    await service.record({ eventType: 'sftp_upload_completed', requestId: 'req-2', hostId: null, metadata: { transferId: 'transfer-1' } });
    await service.record({ eventType: 'connection_failed', requestId: 'req-3', hostId: null });

    const first = await service.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await service.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].map((item) => item.requestId)).toEqual(['req-3', 'req-2', 'req-1']);
    expect((await service.list({ eventType: 'sftp_upload_completed' })).items).toHaveLength(1);
  });

  it('records batch summaries without storing the expanded command or output', async () => {
    const { service } = makeService();
    await service.recordCommandSummary({
      id: 'run-1', command: 'echo secret-value', hostIds: ['host-1', 'host-2'], persistOutput: true, status: 'completed',
      targets: [
        { hostId: 'host-1', status: 'completed', exitCode: 0, output: 'password=secret-value', outputBytes: 20 },
        { hostId: 'host-2', status: 'failed', exitCode: 1, output: 'private-key', outputBytes: 11 }
      ], createdAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:00:01.000Z'
    });
    const events = (await service.list({})).items;
    expect(events[0]).toEqual(expect.objectContaining({ eventType: 'command_run_summary' }));
    expect(JSON.stringify(events)).not.toContain('secret-value');
    expect(JSON.stringify(events)).not.toContain('private-key');
  });

  it('records request identity and non-secret anomaly counts for batch review', async () => {
    const { service } = makeService();
    await service.recordCommandSummary({
      id: 'run-2', requestId: 'request-2', command: 'uname -a', hostIds: ['host-1', 'host-2', 'host-3'], persistOutput: false, status: 'failed',
      targets: [
        { hostId: 'host-1', status: 'completed', exitCode: 0, output: '', outputBytes: 0 },
        { hostId: 'host-2', status: 'failed', exitCode: 1, output: '', outputBytes: 0 },
        { hostId: 'host-3', status: 'cancelled', exitCode: null, output: '', outputBytes: 0, truncated: true }
      ], createdAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:00:01.000Z'
    });
    const event = (await service.list({})).items[0];
    expect(event.requestId).toBe('request-2');
    expect(event.metadata).toEqual(expect.objectContaining({ targetCount: 3, successCount: 1, failureCount: 1, cancelledCount: 1, anomalyCount: 2, truncatedCount: 1 }));
  });
});
