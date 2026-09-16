import { AppError } from '../../shared/errors.js';
import { normalizeWorkspaceState, type WorkspaceState } from '../../shared/core/models.js';
import { parseWorkspaceState } from '../../shared/validation.js';
import type { WorkspaceSnapshot, WorkspaceTemplate } from '../db/types.js';
import { WorkspaceRepository } from './workspace-repository.js';

export const defaultWorkspaceState = (): WorkspaceState => ({
  version: 0,
  tabs: [],
  activeTabId: null,
  layout: { mode: 'single', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

const assertNoDuplicateTabIds = (state: WorkspaceState): void => {
  const ids = state.tabs.map((tab) => tab.id);
  if (new Set(ids).size !== ids.length) throw new AppError('WORKSPACE_INVALID');
  if (state.activeTabId !== null && !ids.includes(state.activeTabId)) throw new AppError('WORKSPACE_INVALID');
};

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}

  load(ownerId: string): WorkspaceState {
    return this.repository.get(ownerId)?.state ?? defaultWorkspaceState();
  }

  save(ownerId: string, expectedVersion: number, state: WorkspaceState): WorkspaceSnapshot {
    const parsed = parseWorkspaceState(state);
    const normalized = normalizeWorkspaceState(parsed);
    assertNoDuplicateTabIds(normalized);
    return this.repository.put(ownerId, expectedVersion, normalized);
  }

  listTemplates(ownerId: string): WorkspaceTemplate[] {
    return this.repository.listTemplates(ownerId);
  }

  createTemplate(ownerId: string, name: string, state: WorkspaceState): WorkspaceTemplate {
    const parsed = normalizeWorkspaceState(parseWorkspaceState(state));
    assertNoDuplicateTabIds(parsed);
    return this.repository.createTemplate(ownerId, name, parsed);
  }

  deleteTemplate(ownerId: string, id: string): void {
    this.repository.deleteTemplate(ownerId, id);
  }
}
