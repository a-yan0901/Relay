import type { HostMetadata } from '@shared/validation';
import type { TerminalStatus } from '@shared/protocol';
import type { WorkspaceState } from '@shared/core/models';
import type { StoragePort } from '../../shared/core/ports';

export type HostMetadataState = HostMetadata;

export interface GroupSummary {
  id: string;
  name: string;
  sortOrder: number;
  parentId?: string | null;
  defaultIdentityId?: string | null;
  connectionProfile?: import('../../shared/core/models').ConnectionProfileOverrides | null;
}

export interface TerminalTabState {
  terminalId: string;
  hostId: string;
  state: TerminalStatus;
  reconnectDelayMs: number;
  errorMessage: string | null;
  /** Runtime-only state explaining why a durable tab is not currently live. */
  recoveryStatus?: WorkspaceRestoreStatus;
  /** Durable tab title used when its Host metadata is no longer available. */
  label?: string;
}

export interface TerminalDescriptor {
  terminalId: string;
  hostId: string;
  workspaceTabId?: string;
}

export type WorkspaceRestoreStatus = 'restored' | 'needs-reopen' | 'missing-host';

export interface WorkspaceRestoreResult {
  tabId: string;
  hostId: string;
  title?: string;
  status: WorkspaceRestoreStatus;
  /** Runtime-only id; never part of the durable workspace snapshot. */
  terminalId: string;
}

export const TERMINAL_DESCRIPTORS_STORAGE_KEY = 'relay.terminal.descriptors.v1';

const defaultSessionStorage = (): StoragePort | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const isSafeWorkspaceTabId = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
);

export const loadTerminalDescriptors = (storage: StoragePort | null | undefined = defaultSessionStorage()): TerminalDescriptor[] => {
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

export const saveTerminalDescriptors = (descriptors: readonly TerminalDescriptor[], storage: StoragePort | null | undefined = defaultSessionStorage()): void => {
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

export const clearTerminalDescriptors = (storage: StoragePort | null | undefined = defaultSessionStorage()): void => {
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
  workspaceRecovery: WorkspaceRestoreResult[];
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
  workspaceRecovery: [],
  favoriteRollback: {},
  errorMessage: null
};

export type AppAction =
  | { type: 'setup'; initialized: boolean; locked?: boolean }
  | { type: 'unlock' }
  | { type: 'lock' }
  | { type: 'hostsLoaded'; hosts: HostMetadataState[] }
  | { type: 'groupsLoaded'; groups: GroupSummary[] }
  | { type: 'workspaceLoaded'; workspace: WorkspaceState; terminalIds: Record<string, string>; restoreResults?: readonly WorkspaceRestoreResult[] }
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
  ...(host.jumpHostIds === undefined ? {} : { jumpHostIds: [...host.jumpHostIds] }),
  ...(host.connectionProfile === undefined ? {} : {
    connectionProfile: {
      ...host.connectionProfile,
      reconnect: { ...host.connectionProfile.reconnect }
    }
  }),
  ...(host.resolvedConnectionProfile === undefined ? {} : {
    resolvedConnectionProfile: {
      ...host.resolvedConnectionProfile,
      reconnect: { ...host.resolvedConnectionProfile.reconnect }
    }
  }),
  ...(host.connectionProfileOverrides === undefined ? {} : {
    connectionProfileOverrides: host.connectionProfileOverrides === null
      ? null
      : {
        ...host.connectionProfileOverrides,
        ...(host.connectionProfileOverrides.reconnect === undefined ? {} : { reconnect: { ...host.connectionProfileOverrides.reconnect } })
      }
  }),
  ...(host.credentialSource === undefined ? {} : { credentialSource: { ...host.credentialSource } }),
  ...(host.identityId === undefined ? {} : { identityId: host.identityId }),
  ...(host.identityName === undefined ? {} : { identityName: host.identityName }),
  ...(host.identitySource === undefined ? {} : { identitySource: host.identitySource })
});

const replaceHost = (hosts: HostMetadataState[], nextHost: HostMetadataState): HostMetadataState[] => {
  const next = safeHostMetadata(nextHost);
  const index = hosts.findIndex((host) => host.id === next.id);
  if (index === -1) {
    return [...hosts, next];
  }
  return hosts.map((host, hostIndex) => hostIndex === index ? next : host);
};

const safeGroupSummary = (group: GroupSummary): GroupSummary => ({
  id: group.id,
  name: group.name,
  sortOrder: group.sortOrder,
  ...(group.parentId === undefined ? {} : { parentId: group.parentId }),
  ...(group.defaultIdentityId === undefined ? {} : { defaultIdentityId: group.defaultIdentityId }),
  ...(group.connectionProfile === undefined ? {} : {
    connectionProfile: group.connectionProfile === null
      ? null
      : { ...group.connectionProfile, reconnect: group.connectionProfile.reconnect ? { ...group.connectionProfile.reconnect } : undefined }
  })
});

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
      return { ...state, phase: 'locked', terminals: [], activeTerminalId: null, workspaceRecovery: [], errorMessage: null };
    case 'hostsLoaded':
      return { ...state, hosts: action.hosts.map(safeHostMetadata), errorMessage: null };
    case 'groupsLoaded':
      return {
        ...state,
        groups: action.groups.map(safeGroupSummary),
        errorMessage: null
      };
    case 'workspaceLoaded': {
      const workspace = safeWorkspace(action.workspace);
      const restoreByTabId = new Map((action.restoreResults ?? []).map((result) => [result.tabId, result]));
      const restoredTerminals = workspace.tabs.flatMap((tab) => {
        const terminalId = action.terminalIds[tab.id];
        const restoreStatus = restoreByTabId.get(tab.id)?.status;
        return terminalId ? [{
          terminalId,
          hostId: tab.hostId,
          // A native SSH handle cannot survive a process restart. Keep the
          // recovery marker internal and let the panel immediately create a
          // fresh shell; exposing needs-reopen here makes the tab briefly look
          // user-actionable even though no action is required.
          state: restoreStatus === 'missing-host'
            ? 'needs-reopen' as const
            : 'closed' as const,
          reconnectDelayMs: 0,
          errorMessage: restoreStatus === 'missing-host' ? '这个工作区标签关联的 Server 已不存在。' : null,
          ...(restoreStatus === 'needs-reopen' ? { state: 'connecting' as const } : {}),
          ...(restoreStatus === undefined ? {} : { recoveryStatus: restoreStatus }),
          ...(tab.title === undefined ? {} : { label: tab.title })
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
        workspaceRecovery: [...(action.restoreResults ?? [])],
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
      const terminals = state.terminals.map((terminal) => terminal.hostId === action.hostId
        ? {
          ...terminal,
          state: 'needs-reopen' as const,
          recoveryStatus: 'missing-host' as const,
          errorMessage: '这个工作区标签关联的 Server 已不存在。'
        }
        : terminal);
      return {
        ...state,
        hosts: state.hosts.filter((host) => host.id !== action.hostId),
        terminals,
        workspaceRecovery: state.workspaceRecovery.map((result) => result.hostId === action.hostId
          ? { ...result, status: 'missing-host' as const }
          : result)
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
    case 'terminalStatusUpdated': {
      const workspaceTabId = state.workspaceTabIdByTerminalId[action.terminalId];
      const terminals = state.terminals.map((terminal) => terminal.terminalId === action.terminalId
        ? (() => {
          const next = {
            ...terminal,
            state: action.state,
            reconnectDelayMs: action.reconnectDelayMs,
            errorMessage: action.errorMessage,
            ...(action.state === 'needs-reopen' ? { recoveryStatus: 'needs-reopen' as const } : {})
          };
          if (terminal.recoveryStatus !== undefined && action.state !== 'needs-reopen' && action.state !== 'closed') {
            delete next.recoveryStatus;
          }
          return next;
        })()
        : terminal);
      const workspaceRecovery = workspaceTabId === undefined
        ? state.workspaceRecovery
        : state.workspaceRecovery.map((result) => result.tabId !== workspaceTabId
          ? result
          : action.state === 'needs-reopen'
            ? { ...result, status: 'needs-reopen' as const }
            : action.state === 'connected' && result.status !== 'missing-host'
              ? { ...result, status: 'restored' as const }
              : result);
      return { ...state, terminals, workspaceRecovery };
    }
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
        workspaceTabIdByTerminalId,
        workspaceRecovery: workspaceTabId
          ? state.workspaceRecovery.filter((result) => result.tabId !== workspaceTabId)
          : state.workspaceRecovery
      };
    }
    case 'error':
      return { ...state, errorMessage: action.message };
    default:
      return state;
  }
};
