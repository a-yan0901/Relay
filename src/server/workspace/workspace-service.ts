import { AppError } from '../../shared/errors.js';
import { normalizeWorkspaceState, type WorkspaceState } from '../../shared/core/models.js';
import { parseWorkspaceState } from '../../shared/validation.js';
import { HostRepository } from '../db/repositories.js';
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
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly hostRepository: HostRepository
  ) {}

  load(ownerId: string): WorkspaceState {
    return this.repository.get(ownerId)?.state ?? defaultWorkspaceState();
  }

  save(ownerId: string, expectedVersion: number, state: WorkspaceState): WorkspaceSnapshot {
    const parsed = parseWorkspaceState(state);
    const normalized = normalizeWorkspaceState(parsed);
    assertNoDuplicateTabIds(normalized);
    for (const tab of normalized.tabs) {
      if (!this.hostRepository.getForConnection(tab.hostId)) throw new AppError('HOST_NOT_FOUND');
    }
    return this.repository.put(ownerId, expectedVersion, normalized);
  }

  listTemplates(ownerId: string): WorkspaceTemplate[] {
    return this.repository.listTemplates(ownerId);
  }

  createTemplate(ownerId: string, name: string, state: WorkspaceState): WorkspaceTemplate {
    const parsed = normalizeWorkspaceState(parseWorkspaceState(state));
    assertNoDuplicateTabIds(parsed);
    for (const tab of parsed.tabs) {
      if (!this.hostRepository.getForConnection(tab.hostId)) throw new AppError('HOST_NOT_FOUND');
    }
    return this.repository.createTemplate(ownerId, name, parsed);
  }

  deleteTemplate(ownerId: string, id: string): void {
    this.repository.deleteTemplate(ownerId, id);
  }
}
