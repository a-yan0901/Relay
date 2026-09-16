import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { WorkspaceState } from '../../shared/core/models.js';
import { workspaceStateSchema } from '../../shared/validation.js';
import type { SqliteDatabase } from '../db/database.js';
import type { WorkspaceSnapshot, WorkspaceTemplate } from '../db/types.js';

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SENSITIVE_KEY = /(password|privatekey|passphrase|credential|token|cookie|terminalid|sessionid|secret)/iu;

const assertOwner = (ownerId: string): void => {
  if (!SAFE_OWNER.test(ownerId)) throw new AppError('WORKSPACE_INVALID');
};

const assertId = (id: string): void => {
  if (!SAFE_ID.test(id)) throw new AppError('WORKSPACE_INVALID');
};

const containsSensitiveKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(child));
};

const parseState = (value: unknown): WorkspaceState => {
  if (containsSensitiveKey(value)) throw new AppError('WORKSPACE_INVALID');
  const parsed = workspaceStateSchema.safeParse(value);
  if (!parsed.success) throw new AppError('WORKSPACE_INVALID');
  return parsed.data;
};

const now = (): string => new Date().toISOString();

interface WorkspaceSqlRow {
  owner_id: string;
  version: number;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface TemplateSqlRow extends WorkspaceSqlRow {
  id: string;
  name: string;
}

const decodeState = (json: string): WorkspaceState => {
  try {
    return parseState(JSON.parse(json));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('WORKSPACE_INVALID');
  }
};

const toSnapshot = (row: WorkspaceSqlRow): WorkspaceSnapshot => {
  const state = decodeState(row.state_json);
  if (state.version !== row.version) throw new AppError('WORKSPACE_INVALID');
  return { ownerId: row.owner_id, version: row.version, state, createdAt: row.created_at, updatedAt: row.updated_at };
};

const toTemplate = (row: TemplateSqlRow): WorkspaceTemplate => ({
  ownerId: row.owner_id,
  id: row.id,
  name: row.name,
  state: decodeState(row.state_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export class WorkspaceRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(ownerId: string): WorkspaceSnapshot | null {
    assertOwner(ownerId);
    const row = this.database.prepare(`
      SELECT owner_id, version, state_json, created_at, updated_at
      FROM workspace_snapshots WHERE owner_id = @ownerId
    `).get({ ownerId }) as WorkspaceSqlRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  put(ownerId: string, expectedVersion: number, state: WorkspaceState): WorkspaceSnapshot {
    assertOwner(ownerId);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new AppError('WORKSPACE_VERSION_CONFLICT');
    const parsed = parseState(state);
    const operation = this.database.transaction(() => {
      const current = this.get(ownerId);
      const nextVersion = current ? current.version + 1 : 1;
      if ((current?.version ?? 0) !== expectedVersion) throw new AppError('WORKSPACE_VERSION_CONFLICT');
      const timestamp = now();
      const nextState: WorkspaceState = { ...parsed, version: nextVersion };
      if (current) {
        this.database.prepare(`
          UPDATE workspace_snapshots
          SET version = @version, state_json = @stateJson, updated_at = @updatedAt
          WHERE owner_id = @ownerId AND version = @expectedVersion
        `).run({ ownerId, version: nextVersion, stateJson: JSON.stringify(nextState), updatedAt: timestamp, expectedVersion });
      } else {
        this.database.prepare(`
          INSERT INTO workspace_snapshots (owner_id, version, state_json, created_at, updated_at)
          VALUES (@ownerId, @version, @stateJson, @createdAt, @updatedAt)
        `).run({ ownerId, version: nextVersion, stateJson: JSON.stringify(nextState), createdAt: timestamp, updatedAt: timestamp });
      }
    });
    operation();
    const saved = this.get(ownerId);
    if (!saved) throw new AppError('INTERNAL_ERROR');
    return saved;
  }

  /** Replace workspace state while an outer snapshot transaction is active. */
  replaceWithinTransaction(ownerId: string, state: WorkspaceState): WorkspaceSnapshot {
    assertOwner(ownerId);
    const parsed = parseState(state);
    const current = this.get(ownerId);
    const timestamp = now();
    if (current) {
      this.database.prepare(`
        UPDATE workspace_snapshots
        SET version = @version, state_json = @stateJson, updated_at = @updatedAt
        WHERE owner_id = @ownerId
      `).run({
        ownerId,
        version: parsed.version,
        stateJson: JSON.stringify(parsed),
        updatedAt: timestamp
      });
    } else {
      this.database.prepare(`
        INSERT INTO workspace_snapshots (owner_id, version, state_json, created_at, updated_at)
        VALUES (@ownerId, @version, @stateJson, @createdAt, @updatedAt)
      `).run({
        ownerId,
        version: parsed.version,
        stateJson: JSON.stringify(parsed),
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
    const saved = this.get(ownerId);
    if (!saved) throw new AppError('INTERNAL_ERROR');
    return saved;
  }

  listTemplates(ownerId: string): WorkspaceTemplate[] {
    assertOwner(ownerId);
    const rows = this.database.prepare(`
      SELECT owner_id, id, name, state_json, created_at, updated_at
      FROM workspace_templates WHERE owner_id = @ownerId ORDER BY updated_at DESC, name COLLATE NOCASE ASC
    `).all({ ownerId }) as TemplateSqlRow[];
    return rows.map(toTemplate);
  }

  createTemplate(ownerId: string, name: string, state: WorkspaceState, id = randomUUID()): WorkspaceTemplate {
    assertOwner(ownerId);
    assertId(id);
    const parsed = parseState(state);
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO workspace_templates (owner_id, id, name, state_json, created_at, updated_at)
        VALUES (@ownerId, @id, @name, @stateJson, @createdAt, @updatedAt)
      `).run({ ownerId, id, name, stateJson: JSON.stringify(parsed), createdAt: timestamp, updatedAt: timestamp });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new AppError('WORKSPACE_INVALID');
      throw error;
    }
    const created = this.database.prepare(`
      SELECT owner_id, id, name, state_json, created_at, updated_at
      FROM workspace_templates WHERE owner_id = @ownerId AND id = @id
    `).get({ ownerId, id }) as TemplateSqlRow | undefined;
    if (!created) throw new AppError('INTERNAL_ERROR');
    return toTemplate(created);
  }

  deleteTemplate(ownerId: string, id: string): void {
    assertOwner(ownerId);
    assertId(id);
    const result = this.database.prepare('DELETE FROM workspace_templates WHERE owner_id = @ownerId AND id = @id')
      .run({ ownerId, id });
    if (result.changes === 0) throw new AppError('NOT_FOUND');
  }
}
