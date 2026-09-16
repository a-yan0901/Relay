import type { WorkspaceLayout, WorkspaceState } from '../../shared/core/models';
import type { AppState } from './app-state';

export const workspaceStateFromAppState = (state: AppState): WorkspaceState => ({
  version: state.workspace.version,
  tabs: state.workspace.tabs
    .filter((tab) => state.terminals.some((terminal) => state.workspaceTabIdByTerminalId[terminal.terminalId] === tab.id))
    .map((tab) => ({ ...tab })),
  activeTabId: state.activeTerminalId
    ? state.workspaceTabIdByTerminalId[state.activeTerminalId] ?? state.workspace.activeTabId
    : state.workspace.activeTabId,
  layout: { ...state.workspace.layout },
  filters: {
    query: state.query,
    groupId: state.selectedGroupId,
    favoriteOnly: state.favoriteOnly
  }
});

export const withWorkspaceLayout = (state: WorkspaceState, layout: WorkspaceLayout): WorkspaceState => ({
  ...state,
  layout: {
    mode: layout.mode,
    ratio: Math.min(0.8, Math.max(0.2, layout.ratio)),
    ...(layout.paneTabIds === undefined ? {} : { paneTabIds: [...layout.paneTabIds].slice(0, 4) })
  }
});

export const createFreshTerminalIds = (
  workspace: WorkspaceState,
  availableHostIds: ReadonlySet<string>,
  createTerminalId: () => string
): Record<string, string> => Object.fromEntries(
  workspace.tabs
    .filter((tab) => availableHostIds.has(tab.hostId))
    .map((tab) => [tab.id, createTerminalId()])
);
