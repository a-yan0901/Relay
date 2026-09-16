import type { WorkspaceLayout, WorkspaceState } from '../../shared/core/models';
import type { AppState, TerminalDescriptor, WorkspaceRestoreResult } from './app-state';

/**
 * Rebuilds runtime terminal rows from the durable workspace intent and the
 * browser-only live descriptors. The returned terminal ids are runtime-only;
 * callers must never write them into WorkspaceState.
 */
export const restoreWorkspace = (
  workspace: WorkspaceState,
  availableHostIds: ReadonlySet<string>,
  descriptors: readonly TerminalDescriptor[],
  createTerminalId: () => string
): WorkspaceRestoreResult[] => {
  const descriptorsByTabId = new Map(
    descriptors
      .filter((descriptor) => descriptor.workspaceTabId !== undefined)
      .map((descriptor) => [descriptor.workspaceTabId as string, descriptor])
  );
  const tabsByHostId = new Map<string, number>();
  for (const tab of workspace.tabs) tabsByHostId.set(tab.hostId, (tabsByHostId.get(tab.hostId) ?? 0) + 1);
  const usedTerminalIds = new Set<string>();

  return workspace.tabs.map((tab) => {
    const directDescriptor = descriptorsByTabId.get(tab.id);
    const legacyDescriptor = directDescriptor === undefined && (tabsByHostId.get(tab.hostId) ?? 0) === 1
      ? descriptors.find((descriptor) => descriptor.workspaceTabId === undefined && descriptor.hostId === tab.hostId && !usedTerminalIds.has(descriptor.terminalId))
      : undefined;
    const descriptor = availableHostIds.has(tab.hostId) && directDescriptor?.hostId === tab.hostId
      ? directDescriptor
      : availableHostIds.has(tab.hostId) && directDescriptor === undefined ? legacyDescriptor : undefined;
    const terminalId = descriptor?.terminalId ?? createTerminalId();
    usedTerminalIds.add(terminalId);
    const status = !availableHostIds.has(tab.hostId)
      ? 'missing-host'
      : descriptor ? 'restored' : 'needs-reopen';
    return {
      tabId: tab.id,
      hostId: tab.hostId,
      ...(tab.title === undefined ? {} : { title: tab.title }),
      status,
      terminalId
    };
  });
};

export const workspaceStateFromAppState = (state: AppState): WorkspaceState => ({
  version: state.workspace.version,
  tabs: state.workspace.tabs.map((tab) => ({ ...tab })),
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
    ...(layout.paneTabIds === undefined ? {} : { paneTabIds: [...new Set(layout.paneTabIds)] })
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
