import type { HostMetadata } from '@shared/validation';
import type { TerminalStatus } from '@shared/protocol';

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
}

export const TERMINAL_DESCRIPTORS_STORAGE_KEY = 'relay.terminal.descriptors.v1';

const sessionStorageOrNull = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

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
    }).slice(0, 32);
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
    }).slice(0, 32);
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
  terminals: TerminalTabState[];
  activeTerminalId: string | null;
  favoriteRollback: Record<string, boolean>;
  errorMessage: string | null;
}

export const initialAppState: AppState = {
  phase: 'loading',
  hosts: [],
  groups: [],
  query: '',
  selectedGroupId: null,
  favoriteOnly: false,
  terminals: [],
  activeTerminalId: null,
  favoriteRollback: {},
  errorMessage: null
};

export type AppAction =
  | { type: 'setup'; initialized: boolean; locked?: boolean }
  | { type: 'unlock' }
  | { type: 'lock' }
  | { type: 'hostsLoaded'; hosts: HostMetadataState[] }
  | { type: 'groupsLoaded'; groups: GroupSummary[] }
  | { type: 'hostCreated'; host: HostMetadataState }
  | { type: 'hostUpdated'; host: HostMetadataState }
  | { type: 'hostDeleted'; hostId: string }
  | { type: 'favoriteOptimistic'; hostId: string; isFavorite: boolean }
  | { type: 'favoriteCommitted'; hostId: string }
  | { type: 'favoriteRollback'; hostId: string }
  | { type: 'groupSelected'; groupId: string | null }
  | { type: 'queryChanged'; query: string }
  | { type: 'favoriteFilterChanged'; favoriteOnly: boolean }
  | { type: 'terminalOpened'; terminalId: string; hostId: string }
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
  updatedAt: host.updatedAt
});

const replaceHost = (hosts: HostMetadataState[], nextHost: HostMetadataState): HostMetadataState[] => {
  const next = safeHostMetadata(nextHost);
  const index = hosts.findIndex((host) => host.id === next.id);
  if (index === -1) {
    return [...hosts, next];
  }
  return hosts.map((host, hostIndex) => hostIndex === index ? next : host);
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
      return { ...state, selectedGroupId: action.groupId };
    case 'queryChanged':
      return { ...state, query: action.query };
    case 'favoriteFilterChanged':
      return { ...state, favoriteOnly: action.favoriteOnly };
    case 'terminalOpened': {
      const existing = state.terminals.some((terminal) => terminal.terminalId === action.terminalId);
      return {
        ...state,
        terminals: existing
          ? state.terminals
          : [...state.terminals, {
            terminalId: action.terminalId,
            hostId: action.hostId,
            state: 'closed',
            reconnectDelayMs: 0,
            errorMessage: null
          }],
        activeTerminalId: action.terminalId
      };
    }
    case 'terminalActivated':
      return state.terminals.some((terminal) => terminal.terminalId === action.terminalId)
        ? { ...state, activeTerminalId: action.terminalId }
        : state;
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
      return { ...state, terminals, activeTerminalId };
    }
    case 'error':
      return { ...state, errorMessage: action.message };
    default:
      return state;
  }
};
