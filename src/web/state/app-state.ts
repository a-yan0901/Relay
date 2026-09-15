import type { HostMetadata } from '@shared/validation';
import type { TerminalStatus } from '@shared/protocol';
import type { WorkspaceState } from '@shared/core/models';

export type HostMetadataState = HostMetadata;

export interface GroupSummary {
  id: string;
  name: string;
  sortOrder: number;
}

export interface TerminalTabState {
  terminalId: string;
  hostId: string;
  state: TerminalStatus;
  reconnectDelayMs: number;
  errorMessage: string | null;
}

export interface TerminalDescriptor {
  terminalId: string;
  hostId: string;
  workspaceTabId?: string;
}

export const TERMINAL_DESCRIPTORS_STORAGE_KEY = 'relay.terminal.descriptors.v1';

const sessionStorageOrNull = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const isSafeWorkspaceTabId = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
);

export const loadTerminalDescriptors = (): TerminalDescriptor[] => {
  const storage = sessionStorageOrNull();
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TERMINAL_DESCRIPTORS_STORAGE_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((value): value is TerminalDescriptor => {
      if (typeof value !== 'object' || value === null || !('terminalId' in value) || !('hostId' in value)) return false;
      const descriptor = value as { terminalId?: unknown; hostId?: unknown };
      if (typeof descriptor.terminalId !== 'string' || descriptor.terminalId.length === 0 || typeof descriptor.hostId !== 'string' || descriptor.hostId.length === 0 || seen.has(descriptor.terminalId)) return false;
      seen.add(descriptor.terminalId);
      return true;
    }).slice(0, 32).map((descriptor) => ({
      terminalId: descriptor.terminalId,
      hostId: descriptor.hostId,
      ...(isSafeWorkspaceTabId(descriptor.workspaceTabId) ? { workspaceTabId: descriptor.workspaceTabId } : {})
    }));
  } catch {
    return [];
  }
};

export const saveTerminalDescriptors = (descriptors: readonly TerminalDescriptor[]): void => {
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    const seen = new Set<string>();
    const safeDescriptors = descriptors.filter((descriptor) => {
      if (!descriptor.terminalId || !descriptor.hostId || seen.has(descriptor.terminalId)) return false;
      seen.add(descriptor.terminalId);
      return true;
    }).slice(0, 32).map((descriptor) => ({
      terminalId: descriptor.terminalId,
      hostId: descriptor.hostId,
      ...(isSafeWorkspaceTabId(descriptor.workspaceTabId) ? { workspaceTabId: descriptor.workspaceTabId } : {})
    }));
    storage.setItem(TERMINAL_DESCRIPTORS_STORAGE_KEY, JSON.stringify(safeDescriptors));
  } catch {
    // Refresh recovery is best effort when browser session storage is unavailable.
  }
};

export const clearTerminalDescriptors = (): void => {
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    storage.removeItem(TERMINAL_DESCRIPTORS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the Vault and live sessions remain unaffected.
  }
};

export type AppPhase = 'loading' | 'setup' | 'locked' | 'ready';

export interface AppState {
  phase: AppPhase;
  hosts: HostMetadataState[];
  groups: GroupSummary[];
  query: string;
  selectedGroupId: string | null;
  favoriteOnly: boolean;
  workspace: WorkspaceState;
  terminals: TerminalTabState[];
  activeTerminalId: string | null;
  workspaceTabIdByTerminalId: Record<string, string>;
  favoriteRollback: Record<string, boolean>;
  errorMessage: string | null;
}

export const defaultWorkspaceState: WorkspaceState = {
  version: 0,
  tabs: [],
  activeTabId: null,
  layout: { mode: 'single', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
};

export const initialAppState: AppState = {
  phase: 'loading',
  hosts: [],
  groups: [],
  query: '',
  selectedGroupId: null,
  favoriteOnly: false,
  workspace: defaultWorkspaceState,
  terminals: [],
  activeTerminalId: null,
  workspaceTabIdByTerminalId: {},
  favoriteRollback: {},
  errorMessage: null
};

export type AppAction =
  | { type: 'setup'; initialized: boolean; locked?: boolean }
  | { type: 'unlock' }
  | { type: 'lock' }
  | { type: 'hostsLoaded'; hosts: HostMetadataState[] }
  | { type: 'groupsLoaded'; groups: GroupSummary[] }
  | { type: 'workspaceLoaded'; workspace: WorkspaceState; terminalIds: Record<string, string> }
  | { type: 'workspaceSynced'; workspace: WorkspaceState }
  | { type: 'workspaceLayoutChanged'; layout: WorkspaceState['layout'] }
  | { type: 'hostCreated'; host: HostMetadataState }
  | { type: 'hostUpdated'; host: HostMetadataState }
  | { type: 'hostDeleted'; hostId: string }
  | { type: 'favoriteOptimistic'; hostId: string; isFavorite: boolean }
  | { type: 'favoriteCommitted'; hostId: string }
  | { type: 'favoriteRollback'; hostId: string }
  | { type: 'groupSelected'; groupId: string | null }
  | { type: 'queryChanged'; query: string }
  | { type: 'favoriteFilterChanged'; favoriteOnly: boolean }
  | { type: 'terminalOpened'; terminalId: string; hostId: string; workspaceTabId?: string }
  | { type: 'terminalActivated'; terminalId: string }
  | { type: 'terminalStatusUpdated'; terminalId: string; state: TerminalStatus; reconnectDelayMs: number; errorMessage: string | null }
  | { type: 'terminalClosed'; terminalId: string }
  | { type: 'error'; message: string | null };

const safeHostMetadata = (host: HostMetadataState): HostMetadataState => ({
  id: host.id,
  name: host.name,
  address: host.address,
  port: host.port,
  username: host.username,
  authType: host.authType,
  groupId: host.groupId,
  tags: [...host.tags],
  isFavorite: host.isFavorite,
  hostKeyAlgorithm: host.hostKeyAlgorithm,
  hostKeyFingerprint: host.hostKeyFingerprint,
  lastConnectedAt: host.lastConnectedAt,
  createdAt: host.createdAt,
  updatedAt: host.updatedAt,
  ...(host.jumpHostIds === undefined ? {} : { jumpHostIds: [...host.jumpHostIds] })
});

const replaceHost = (hosts: HostMetadataState[], nextHost: HostMetadataState): HostMetadataState[] => {
  const next = safeHostMetadata(nextHost);
  const index = hosts.findIndex((host) => host.id === next.id);
  if (index === -1) {
    return [...hosts, next];
  }
  return hosts.map((host, hostIndex) => hostIndex === index ? next : host);
};

const safeWorkspace = (workspace: WorkspaceState): WorkspaceState => ({
  version: workspace.version,
  tabs: workspace.tabs.map((tab) => ({ ...tab })),
  activeTabId: workspace.activeTabId,
  layout: { ...workspace.layout },
  filters: { ...workspace.filters }
});

const opaqueWorkspaceTabId = (terminalId: string): string => {
  // The fallback keeps reducer-only callers deterministic without putting a
  // live session identifier into the durable workspace snapshot.
  let hash = 2_166_136_261;
  for (const character of terminalId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `tab-${(hash >>> 0).toString(36)}`;
};

const isWorkspaceTabId = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
);

const workspaceTabForTerminal = (state: AppState, terminalId: string): string => (
  state.workspaceTabIdByTerminalId[terminalId] ?? opaqueWorkspaceTabId(terminalId)
);

const withWorkspaceTab = (state: AppState, terminalId: string, hostId: string, requestedTabId?: string): AppState => {
  const id = isWorkspaceTabId(requestedTabId) ? requestedTabId : workspaceTabForTerminal(state, terminalId);
  const tabs = state.workspace.tabs.some((tab) => tab.id === id)
    ? state.workspace.tabs
    : [...state.workspace.tabs, { id, hostId }];
  return {
    ...state,
    workspace: { ...state.workspace, tabs, activeTabId: id },
    workspaceTabIdByTerminalId: { ...state.workspaceTabIdByTerminalId, [terminalId]: id }
  };
};

export const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'setup':
      return {
        ...state,
        phase: !action.initialized ? 'setup' : action.locked === false ? 'ready' : 'locked',
        errorMessage: null
      };
    case 'unlock':
      return { ...state, phase: 'ready', errorMessage: null };
    case 'lock':
      return { ...state, phase: 'locked', terminals: [], activeTerminalId: null, errorMessage: null };
    case 'hostsLoaded':
      return { ...state, hosts: action.hosts.map(safeHostMetadata), errorMessage: null };
    case 'groupsLoaded':
      return {
        ...state,
        groups: action.groups.map((group) => ({ id: group.id, name: group.name, sortOrder: group.sortOrder })),
        errorMessage: null
      };
    case 'workspaceLoaded': {
      const workspace = safeWorkspace(action.workspace);
      const restoredTerminals = workspace.tabs.flatMap((tab) => {
        const terminalId = action.terminalIds[tab.id];
        return terminalId ? [{
          terminalId,
          hostId: tab.hostId,
          state: 'closed' as const,
          reconnectDelayMs: 0,
          errorMessage: null
        }] : [];
      });
      const workspaceTabIdByTerminalId = Object.fromEntries(
        Object.entries(action.terminalIds).map(([tabId, terminalId]) => [terminalId, tabId])
      );
      const activeTerminalId = workspace.activeTabId ? action.terminalIds[workspace.activeTabId] ?? null : null;
      return {
        ...state,
        workspace,
        query: workspace.filters.query,
        selectedGroupId: workspace.filters.groupId,
        favoriteOnly: workspace.filters.favoriteOnly,
        terminals: restoredTerminals,
        activeTerminalId,
        workspaceTabIdByTerminalId,
        errorMessage: null
      };
    }
    case 'workspaceSynced': {
      const workspace = safeWorkspace(action.workspace);
      return {
        ...state,
        workspace,
        query: workspace.filters.query,
        selectedGroupId: workspace.filters.groupId,
        favoriteOnly: workspace.filters.favoriteOnly
      };
    }
    case 'workspaceLayoutChanged':
      return { ...state, workspace: { ...state.workspace, layout: { ...action.layout } } };
    case 'hostCreated':
      return { ...state, hosts: replaceHost(state.hosts, action.host), errorMessage: null };
    case 'hostUpdated':
      return { ...state, hosts: replaceHost(state.hosts, action.host), errorMessage: null };
    case 'hostDeleted': {
      const terminals = state.terminals.filter((terminal) => terminal.hostId !== action.hostId);
      const activeTerminalId = terminals.some((terminal) => terminal.terminalId === state.activeTerminalId)
        ? state.activeTerminalId
        : terminals.at(-1)?.terminalId ?? null;
      return {
        ...state,
        hosts: state.hosts.filter((host) => host.id !== action.hostId),
        terminals,
        activeTerminalId
      };
    }
    case 'favoriteOptimistic': {
      const host = state.hosts.find((candidate) => candidate.id === action.hostId);
      if (!host) return state;
      return {
        ...state,
        hosts: state.hosts.map((candidate) => candidate.id === action.hostId
          ? { ...candidate, isFavorite: action.isFavorite }
          : candidate),
        favoriteRollback: {
          ...state.favoriteRollback,
          [action.hostId]: state.favoriteRollback[action.hostId] ?? host.isFavorite
        }
      };
    }
    case 'favoriteCommitted': {
      if (state.favoriteRollback[action.hostId] === undefined) return state;
      const rollback = { ...state.favoriteRollback };
      delete rollback[action.hostId];
      return { ...state, favoriteRollback: rollback };
    }
    case 'favoriteRollback': {
      const previous = state.favoriteRollback[action.hostId];
      if (previous === undefined) return state;
      const rollback = { ...state.favoriteRollback };
      delete rollback[action.hostId];
      return {
        ...state,
        hosts: state.hosts.map((host) => host.id === action.hostId ? { ...host, isFavorite: previous } : host),
        favoriteRollback: rollback
      };
    }
    case 'groupSelected':
      return {
        ...state,
        selectedGroupId: action.groupId,
        workspace: { ...state.workspace, filters: { ...state.workspace.filters, groupId: action.groupId } }
      };
    case 'queryChanged':
      return {
        ...state,
        query: action.query,
        workspace: { ...state.workspace, filters: { ...state.workspace.filters, query: action.query } }
      };
    case 'favoriteFilterChanged':
      return {
        ...state,
        favoriteOnly: action.favoriteOnly,
        workspace: { ...state.workspace, filters: { ...state.workspace.filters, favoriteOnly: action.favoriteOnly } }
      };
    case 'terminalOpened': {
      const existing = state.terminals.some((terminal) => terminal.terminalId === action.terminalId);
      const next = {
        ...state,
        terminals: existing
          ? state.terminals
          : [...state.terminals, {
            terminalId: action.terminalId,
            hostId: action.hostId,
            state: 'closed' as const,
            reconnectDelayMs: 0,
            errorMessage: null
          }],
        activeTerminalId: action.terminalId
      };
      return existing ? next : withWorkspaceTab(next, action.terminalId, action.hostId, action.workspaceTabId);
    }
    case 'terminalActivated':
      if (!state.terminals.some((terminal) => terminal.terminalId === action.terminalId)) return state;
      return {
        ...state,
        activeTerminalId: action.terminalId,
        workspace: { ...state.workspace, activeTabId: workspaceTabForTerminal(state, action.terminalId) }
      };
    case 'terminalStatusUpdated':
      return {
        ...state,
        terminals: state.terminals.map((terminal) => terminal.terminalId === action.terminalId
          ? {
            ...terminal,
            state: action.state,
            reconnectDelayMs: action.reconnectDelayMs,
            errorMessage: action.errorMessage
          }
          : terminal)
      };
    case 'terminalClosed': {
      const closingIndex = state.terminals.findIndex((terminal) => terminal.terminalId === action.terminalId);
      const terminals = state.terminals.filter((terminal) => terminal.terminalId !== action.terminalId);
      const activeTerminalId = state.activeTerminalId === action.terminalId
        ? terminals[Math.max(0, Math.min(closingIndex - 1, terminals.length - 1))]?.terminalId ?? null
        : state.activeTerminalId;
      const workspaceTabId = state.workspaceTabIdByTerminalId[action.terminalId];
      const workspaceTabs = workspaceTabId
        ? state.workspace.tabs.filter((tab) => tab.id !== workspaceTabId)
        : state.workspace.tabs;
      const workspaceTabIdByTerminalId = { ...state.workspaceTabIdByTerminalId };
      delete workspaceTabIdByTerminalId[action.terminalId];
      const activeTabId = activeTerminalId ? workspaceTabForTerminal({ ...state, workspaceTabIdByTerminalId }, activeTerminalId) : null;
      return {
        ...state,
        terminals,
        activeTerminalId,
        workspace: { ...state.workspace, tabs: workspaceTabs, activeTabId },
        workspaceTabIdByTerminalId
      };
    }
    case 'error':
      return { ...state, errorMessage: action.message };
    default:
      return state;
  }
};
