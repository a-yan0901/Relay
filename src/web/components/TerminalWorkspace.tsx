import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { HostMetadataState, TerminalTabState } from '../state/app-state';
import type { SftpEntry, TransferJob, WorkspaceLayout } from '../../shared/core/models';
import type { TerminalSessionSnapshot } from '../hooks/use-terminal-session';
import { DEFAULT_PREFERENCES, type UiPreferences } from '../theme';
import { terminalStatusDotClass, terminalStatusLabels, TerminalToolbar } from './TerminalToolbar';
import { TerminalPanel, type TerminalPanelToolbarState } from './TerminalPanel';
import { SftpPanel } from './SftpPanel';
import { TransferQueue } from './TransferQueue';

type SplitOrientation = 'horizontal' | 'vertical';
type PaneKey = 'primary' | 'secondary';

interface SplitLayout {
  orientation: SplitOrientation;
  primaryId: string | null;
  secondaryId: string | null;
}

export interface TerminalWorkspaceProps {
  hosts?: HostMetadataState[];
  terminals: TerminalTabState[];
  activeTerminalId: string | null;
  onActivate: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onEditHost?: (host: HostMetadataState) => void;
  onConnectHost?: (host: HostMetadataState) => void;
  onOpenBatchCommand?: () => void;
  onOpenSnippetPalette?: () => void;
  onListSftp?: (hostId: string, path: string) => Promise<readonly SftpEntry[]>;
  onCreateDirectorySftp?: (hostId: string, path: string) => Promise<void>;
  onRenameSftp?: (hostId: string, from: string, to: string) => Promise<void>;
  onDeleteSftp?: (hostId: string, path: string) => Promise<void>;
  onUploadSftp?: (hostId: string, file: File, path: string) => Promise<void>;
  onDownloadSftp?: (hostId: string, path: string, name: string) => Promise<void>;
  transferJobs?: readonly TransferJob[];
  onCancelTransfer?: (id: string) => void;
  onRetryTransfer?: (id: string) => void;
  onStatusChange?: (terminalId: string, snapshot: TerminalSessionSnapshot) => void;
  preferences?: UiPreferences;
  onBackToHosts?: () => void;
  visible?: boolean;
  workspaceHeader?: ReactNode;
  workspaceLayout?: WorkspaceLayout;
  workspaceTabIdByTerminalId?: Readonly<Record<string, string>>;
  onLayoutChange?: (layout: WorkspaceLayout) => void;
  allowMultiPane?: boolean;
}

const clampSplitRatio = (ratio: number): number => Math.round(Math.min(0.8, Math.max(0.2, ratio)) * 100) / 100;

const replacePane = (layout: SplitLayout, pane: PaneKey, terminalId: string | null): SplitLayout => (
  pane === 'primary' ? { ...layout, primaryId: terminalId } : { ...layout, secondaryId: terminalId }
);

const paneLabel = (pane: PaneKey): string => pane === 'primary' ? '左侧 Console' : '右侧 Console';

const splitLayoutFromWorkspace = (layout: WorkspaceLayout | undefined, terminalIds: readonly string[]): SplitLayout | null => {
  if (!layout || layout.mode === 'single') return null;
  return {
    orientation: layout.mode === 'grid' ? 'vertical' : layout.mode,
    primaryId: terminalIds[0] ?? null,
    secondaryId: terminalIds[1] ?? null
  };
};

const gridTerminalIdsFromWorkspace = (
  layout: WorkspaceLayout | undefined,
  terminals: readonly TerminalTabState[],
  workspaceTabIdByTerminalId: Readonly<Record<string, string>> | undefined
): string[] => {
  const terminalIdByWorkspaceTabId = new Map(Object.entries(workspaceTabIdByTerminalId ?? {}).map(([terminalId, tabId]) => [tabId, terminalId]));
  const requested = layout?.paneTabIds?.map((tabId) => terminalIdByWorkspaceTabId.get(tabId)).filter((id): id is string => id !== undefined) ?? [];
  return [...new Set([...requested, ...terminals.map((terminal) => terminal.terminalId)])].slice(0, 4);
};

export const TerminalWorkspace = ({
  hosts = [],
  terminals,
  activeTerminalId,
  onActivate,
  onClose,
  onConnectHost,
  onOpenBatchCommand,
  onOpenSnippetPalette,
  onListSftp,
  onCreateDirectorySftp,
  onRenameSftp,
  onDeleteSftp,
  onUploadSftp,
  onDownloadSftp,
  transferJobs = [],
  onCancelTransfer,
  onRetryTransfer,
  onStatusChange,
  onEditHost,
  preferences = DEFAULT_PREFERENCES,
  onBackToHosts,
  visible: workspaceVisible = true,
  workspaceHeader,
  workspaceLayout,
  workspaceTabIdByTerminalId,
  onLayoutChange,
  allowMultiPane = true
}: TerminalWorkspaceProps) => {
  const [hostQuery, setHostQuery] = useState('');
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [splitLayout, setSplitLayout] = useState<SplitLayout | null>(() => splitLayoutFromWorkspace(workspaceLayout, terminals.map((terminal) => terminal.terminalId)));
  const [gridLayout, setGridLayout] = useState(() => workspaceLayout?.mode === 'grid');
  const [gridTerminalIds, setGridTerminalIds] = useState(() => gridTerminalIdsFromWorkspace(workspaceLayout, terminals, workspaceTabIdByTerminalId));
  const [focusedGridIndex, setFocusedGridIndex] = useState(0);
  const [focusedPane, setFocusedPane] = useState<PaneKey>('primary');
  const [splitRatio, setSplitRatio] = useState(() => clampSplitRatio(workspaceLayout?.ratio ?? 0.5));
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const [toolbarByTerminalId, setToolbarByTerminalId] = useState<Record<string, TerminalPanelToolbarState | null>>({});
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pendingPaneRef = useRef<PaneKey | null>(null);
  const previousTerminalIdsRef = useRef(new Set(terminals.map((terminal) => terminal.terminalId)));

  useEffect(() => {
    if (!allowMultiPane) {
      setGridLayout(false);
      setGridTerminalIds([]);
      setSplitLayout(null);
      return;
    }
    if (!workspaceLayout) return;
    setSplitRatio(clampSplitRatio(workspaceLayout.ratio));
    setGridLayout(workspaceLayout.mode === 'grid');
    if (workspaceLayout.mode === 'grid') {
      setSplitLayout(null);
      setGridTerminalIds(gridTerminalIdsFromWorkspace(workspaceLayout, terminals, workspaceTabIdByTerminalId));
    } else {
      setGridTerminalIds([]);
      setSplitLayout(splitLayoutFromWorkspace(workspaceLayout, terminals.map((terminal) => terminal.terminalId)));
    }
  }, [allowMultiPane, terminals, workspaceLayout?.mode, workspaceLayout?.ratio, workspaceLayout?.paneTabIds, workspaceTabIdByTerminalId]);

  const handleToolbarChange = useCallback((terminalId: string, toolbar: TerminalPanelToolbarState | null): void => {
    setToolbarByTerminalId((current) => current[terminalId] === toolbar ? current : { ...current, [terminalId]: toolbar });
  }, []);

  const visibleHosts = useMemo(() => {
    const normalized = hostQuery.trim().toLowerCase();
    return hosts.filter((host) => !normalized || `${host.name} ${host.address} ${host.username}`.toLowerCase().includes(normalized));
  }, [hostQuery, hosts]);

  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const terminalById = useMemo(() => new Map(terminals.map((terminal) => [terminal.terminalId, terminal])), [terminals]);
  const terminalLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const hostOrdinals = new Map<string, number>();
    terminals.forEach((terminal) => {
      const host = hostById.get(terminal.hostId);
      const hostLabel = host?.name ?? terminal.label ?? terminal.hostId;
      const ordinal = (hostOrdinals.get(terminal.hostId) ?? 0) + 1;
      hostOrdinals.set(terminal.hostId, ordinal);
      labels.set(terminal.terminalId, `${hostLabel} · ${ordinal}`);
    });
    return labels;
  }, [hostById, terminals]);

  useEffect(() => {
    const currentIds = new Set(terminals.map((terminal) => terminal.terminalId));
    const addedTerminal = terminals.find((terminal) => !previousTerminalIdsRef.current.has(terminal.terminalId));
    previousTerminalIdsRef.current = currentIds;
    const pendingPane = pendingPaneRef.current;
    if (!addedTerminal) return;
    if (gridLayout) {
      setGridTerminalIds((current) => current.includes(addedTerminal.terminalId) || current.length >= 4 ? current : [...current, addedTerminal.terminalId]);
      return;
    }
    if (!pendingPane) return;
    setSplitLayout((layout) => layout ? replacePane(layout, pendingPane, addedTerminal.terminalId) : layout);
    setFocusedPane(pendingPane);
    pendingPaneRef.current = null;
  }, [gridLayout, terminals]);

  const fallbackTerminalId = activeTerminalId && terminalById.has(activeTerminalId)
    ? activeTerminalId
    : terminals[0]?.terminalId ?? null;
  const primaryTerminalId = splitLayout
    ? splitLayout.primaryId && terminalById.has(splitLayout.primaryId) ? splitLayout.primaryId : fallbackTerminalId
    : fallbackTerminalId;
  const secondaryCandidate = terminals.find((terminal) => terminal.terminalId !== primaryTerminalId)?.terminalId ?? null;
  const secondaryTerminalId = splitLayout
    ? splitLayout.secondaryId && terminalById.has(splitLayout.secondaryId) && splitLayout.secondaryId !== primaryTerminalId
      ? splitLayout.secondaryId
      : secondaryCandidate
    : null;
  const visibleGridTerminalIds = gridTerminalIds.filter((terminalId) => terminalById.has(terminalId)).slice(0, 4);
  const activeToolbar = activeTerminalId ? toolbarByTerminalId[activeTerminalId] : null;
  const activeHostId = activeTerminalId ? terminalById.get(activeTerminalId)?.hostId ?? null : null;

  const labelForTerminal = (terminalId: string | null): string => {
    if (!terminalId) return '选择 Console';
    const terminal = terminalById.get(terminalId);
    return terminalLabels.get(terminalId) ?? hostById.get(terminal?.hostId ?? '')?.name ?? terminal?.label ?? terminal?.hostId ?? 'Console';
  };

  if (terminals.length === 0) {
    return (
      <section className="terminal-empty-state" aria-label="终端工作区">
        <div className="empty-state-illustration" aria-hidden="true">⌁</div>
        <p className="eyebrow">TERMINAL WORKSPACE</p>
        <h1>选择一台 Server 开始连接</h1>
        <p>打开终端后，你可以在顶部页签切换多个 SSH 会话。</p>
        {onBackToHosts && <button className="button button-primary" type="button" onClick={onBackToHosts}>返回 Server 列表</button>}
      </section>
    );
  }

  const requestConnectHost = (host: HostMetadataState, pane: PaneKey = focusedPane): void => {
    if (!onConnectHost) return;
    if (splitLayout) pendingPaneRef.current = pane;
    onConnectHost(host);
    setHostPickerOpen(false);
    setHostQuery('');
  };

  const selectPaneTerminal = (pane: PaneKey, terminalId: string): void => {
    if (!splitLayout || !terminalById.has(terminalId)) return;
    const otherId = pane === 'primary' ? secondaryTerminalId : primaryTerminalId;
    if (terminalId === otherId) return;
    setSplitLayout((layout) => layout ? replacePane(layout, pane, terminalId) : layout);
    setFocusedPane(pane);
    onActivate(terminalId);
  };

  const selectGridTerminal = (index: number, terminalId: string): void => {
    if (!gridLayout || !terminalById.has(terminalId) || visibleGridTerminalIds.some((id, candidateIndex) => candidateIndex !== index && id === terminalId)) return;
    setGridTerminalIds((current) => current.map((id, candidateIndex) => candidateIndex === index ? terminalId : id));
    setFocusedGridIndex(index);
    onActivate(terminalId);
  };

  const activateTerminal = (terminalId: string): void => {
    if (gridLayout) {
      const existingIndex = visibleGridTerminalIds.indexOf(terminalId);
      if (existingIndex >= 0) setFocusedGridIndex(existingIndex);
      else if (visibleGridTerminalIds.length > 0) {
        const replacementIndex = Math.min(focusedGridIndex, visibleGridTerminalIds.length - 1);
        setGridTerminalIds((current) => current.map((id, index) => index === replacementIndex ? terminalId : id));
        setFocusedGridIndex(replacementIndex);
      }
      onActivate(terminalId);
      return;
    }
    if (splitLayout) {
      const pane = terminalId === primaryTerminalId ? 'primary' : terminalId === secondaryTerminalId ? 'secondary' : focusedPane;
      if (terminalId !== primaryTerminalId && terminalId !== secondaryTerminalId) {
        setSplitLayout((layout) => layout ? replacePane(layout, pane, terminalId) : layout);
      }
      setFocusedPane(pane);
    }
    onActivate(terminalId);
  };

  const toggleSplit = (orientation: SplitOrientation): void => {
    if (gridLayout) {
      setGridLayout(false);
      setGridTerminalIds([]);
      setFocusedPane('primary');
      onLayoutChange?.({ mode: orientation, ratio: splitRatio });
      return;
    }
    if (splitLayout?.orientation === orientation) {
      setSplitLayout(null);
      setFocusedPane('primary');
      onLayoutChange?.({ mode: 'single', ratio: splitRatio });
      return;
    }
    const primaryId = primaryTerminalId;
    const secondaryId = splitLayout?.secondaryId && terminalById.has(splitLayout.secondaryId) && splitLayout.secondaryId !== primaryId
      ? splitLayout.secondaryId
      : secondaryCandidate;
    setSplitLayout({ orientation, primaryId, secondaryId });
    onLayoutChange?.({ mode: orientation, ratio: splitRatio });
    const nextFocusedPane: PaneKey = secondaryId ? 'primary' : 'secondary';
    setFocusedPane(nextFocusedPane);
    if (!secondaryId && onConnectHost) setHostPickerOpen(true);
  };

  const gridPaneTabIds = (): string[] => visibleGridTerminalIds
    .map((terminalId) => workspaceTabIdByTerminalId?.[terminalId])
    .filter((tabId): tabId is string => tabId !== undefined);

  const toggleGrid = (): void => {
    if (gridLayout) {
      setGridLayout(false);
      setGridTerminalIds([]);
      setFocusedPane('primary');
      onLayoutChange?.({ mode: 'single', ratio: splitRatio });
      return;
    }
    setSplitLayout(null);
    setGridLayout(true);
    const ids = [...new Set([...visibleGridTerminalIds, ...terminals.map((terminal) => terminal.terminalId)])].slice(0, 4);
    setGridTerminalIds(ids);
    setFocusedGridIndex(0);
    onLayoutChange?.({ mode: 'grid', ratio: splitRatio, paneTabIds: ids.map((terminalId) => workspaceTabIdByTerminalId?.[terminalId]).filter((tabId): tabId is string => tabId !== undefined) });
  };

  const openHostPicker = (): void => {
    setHostPickerOpen((open) => !open);
    setHostQuery('');
  };

  const updateSplitRatio = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isDraggingDivider || !layoutRef.current) return;
    const bounds = layoutRef.current.getBoundingClientRect();
    const ratio = splitLayout?.orientation === 'horizontal'
      ? (event.clientX - bounds.left) / bounds.width
      : (event.clientY - bounds.top) / bounds.height;
    const nextRatio = clampSplitRatio(ratio);
    setSplitRatio(nextRatio);
    onLayoutChange?.(gridLayout
      ? { mode: 'grid', ratio: nextRatio, paneTabIds: gridPaneTabIds() }
      : { mode: splitLayout?.orientation ?? 'single', ratio: nextRatio });
  };

  const stopDraggingDivider = (): void => setIsDraggingDivider(false);
  const updateSplitRatioFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!splitLayout && !gridLayout) return;
    if (gridLayout && !splitLayout) {
      if (event.key === 'Home' || event.key === 'End' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const nextRatio = event.key === 'Home' ? 0.2 : event.key === 'End' ? 0.8 : clampSplitRatio(splitRatio + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 0.05 : -0.05));
        setSplitRatio(nextRatio);
        onLayoutChange?.({ mode: 'grid', ratio: nextRatio, paneTabIds: gridPaneTabIds() });
      }
      return;
    }
    if (!splitLayout) return;
    const isHorizontal = splitLayout.orientation === 'horizontal';
    const positiveKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
    const negativeKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === 'Home') {
      event.preventDefault();
      setSplitRatio(0.2);
      onLayoutChange?.({ mode: splitLayout.orientation, ratio: 0.2 });
    } else if (event.key === 'End') {
      event.preventDefault();
      setSplitRatio(0.8);
      onLayoutChange?.({ mode: splitLayout.orientation, ratio: 0.8 });
    } else if (event.key === positiveKey || event.key === negativeKey) {
      event.preventDefault();
      const nextRatio = clampSplitRatio(splitRatio + (event.key === positiveKey ? 0.05 : -0.05));
      setSplitRatio(nextRatio);
      onLayoutChange?.({ mode: splitLayout.orientation, ratio: nextRatio });
    }
  };
  const layoutStyle: CSSProperties | undefined = splitLayout || gridLayout ? { '--split-ratio': `${splitRatio * 100}%` } as CSSProperties : undefined;

  return (
    <div className="terminal-workspace-shell">
      <section className="terminal-main" aria-label="终端标签工作区">
        <div className="terminal-topbar" role="toolbar" aria-label="终端导航与工作区操作">
          {workspaceHeader}
          {onBackToHosts && <button className="terminal-back-button" type="button" aria-label="← Server 列表" onClick={onBackToHosts}>← Server</button>}
          <div className="terminal-tabs" role="tablist" aria-label="终端标签">
            {terminals.map((terminal) => {
              const host = hostById.get(terminal.hostId);
              const label = terminalLabels.get(terminal.terminalId) ?? host?.name ?? terminal.label ?? terminal.hostId;
              const selected = terminal.terminalId === activeTerminalId;
              return (
                <div className={`terminal-tab ${selected ? 'is-active' : ''}`} key={terminal.terminalId}>
                  <button className="terminal-tab-trigger" type="button" role="tab" aria-selected={selected} aria-label={`切换 ${label}`} onClick={() => activateTerminal(terminal.terminalId)}>
                    <span className={`status-dot ${terminalStatusDotClass(terminal.state)}`} aria-hidden="true" />
                    <span className="terminal-tab-meta"><strong>{label}</strong><small>{host?.address ?? 'Server 已不存在'}</small></span>
                    <span className="terminal-tab-status">{terminal.recoveryStatus === 'missing-host' ? 'Server 已不存在' : terminalStatusLabels[terminal.state]}</span>
                  </button>
                  <button className="terminal-tab-close" type="button" aria-label={`关闭 ${label}`} onClick={(event) => { event.stopPropagation(); onClose(terminal.terminalId); }}>×</button>
                </div>
              );
            })}
          </div>
          <div className="terminal-topbar-actions">
            {activeToolbar && activeTerminalId && <TerminalToolbar
              state={activeToolbar.state}
              reconnectDelayMs={activeToolbar.reconnectDelayMs}
              networkOffline={activeToolbar.networkOffline}
              diagnostic={activeToolbar.diagnostic}
              onReconnect={activeToolbar.onReconnect}
              onClose={() => onClose(activeTerminalId)}
              onClear={activeToolbar.onClear}
              onSearch={activeToolbar.onSearch}
              onFullscreen={activeToolbar.onFullscreen}
              searchActive={activeToolbar.searchActive}
              showStatus
            />}
            {onConnectHost && (
              <div className="terminal-host-picker-anchor">
                <button id="terminal-new-terminal" className="terminal-topbar-button terminal-new-button" type="button" aria-label="新建终端" aria-expanded={hostPickerOpen} onClick={openHostPicker}>＋<span>新建</span></button>
                {hostPickerOpen && (
                  <div className="terminal-host-picker" role="dialog" aria-label="选择 Server">
                    <div className="terminal-host-picker-heading"><strong>新建 Console</strong><button className="icon-button" type="button" aria-label="关闭 Server 选择器" onClick={() => setHostPickerOpen(false)}>×</button></div>
                    <label className="terminal-host-picker-search" htmlFor="terminal-host-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索 Server</span><input id="terminal-host-search" aria-label="搜索 Server" autoFocus value={hostQuery} onChange={(event) => setHostQuery(event.target.value)} placeholder="搜索 Server" /></label>
                    <div className="terminal-host-picker-list">
                      {visibleHosts.map((host) => <button className="terminal-host-picker-item" type="button" key={host.id} aria-label={`新建终端：${host.name}`} onClick={() => requestConnectHost(host)}><span><span className="status-dot status-dot-muted" aria-hidden="true" />{host.name}</span><small>{host.username}@{host.address}</small></button>)}
                      {visibleHosts.length === 0 && <p className="terminal-host-picker-empty">没有匹配的 Server</p>}
                    </div>
                  </div>
                )}
              </div>
            )}
            {onOpenBatchCommand && <button className="terminal-topbar-button" type="button" aria-label="批量执行" onClick={onOpenBatchCommand}>⌘<span>批量</span></button>}
            {onOpenSnippetPalette && <button className="terminal-topbar-button" type="button" aria-label="命令片段" onClick={onOpenSnippetPalette}>✦<span>片段</span></button>}
            {onListSftp && <button className="terminal-topbar-button" type="button" aria-label="远程文件" aria-pressed={filePanelOpen} onClick={() => setFilePanelOpen((open) => !open)}>▤<span>文件</span></button>}
            {allowMultiPane && <>
              <button className="terminal-topbar-button" type="button" aria-label="左右分屏" aria-pressed={splitLayout?.orientation === 'horizontal'} onClick={() => toggleSplit('horizontal')} title="左右分屏">◫</button>
              <button className="terminal-topbar-button" type="button" aria-label="上下分屏" aria-pressed={splitLayout?.orientation === 'vertical'} onClick={() => toggleSplit('vertical')} title="上下分屏">▤</button>
              <button className="terminal-topbar-button" type="button" aria-label="四格布局" aria-pressed={gridLayout} onClick={toggleGrid} title="最多四格布局">⊞<span>四格</span></button>
              {(splitLayout || gridLayout) && <button className="terminal-topbar-button terminal-exit-split-button" type="button" aria-label="退出分屏" onClick={() => { setSplitLayout(null); setGridLayout(false); setGridTerminalIds([]); setFocusedPane('primary'); onLayoutChange?.({ mode: 'single', ratio: splitRatio }); }}>×<span>退出分屏</span></button>}
            </>}
          </div>
        </div>
        <div
          className={`terminal-layout ${gridLayout ? 'is-grid' : splitLayout ? `is-split-${splitLayout.orientation}` : 'is-single'} ${isDraggingDivider ? 'is-dragging' : ''}`}
          ref={layoutRef}
          style={layoutStyle}
        >
          {terminals.map((terminal) => {
            const host = hostById.get(terminal.hostId);
            const pane: PaneKey | null = terminal.terminalId === primaryTerminalId
              ? 'primary'
              : terminal.terminalId === secondaryTerminalId ? 'secondary' : null;
            const gridIndex = gridLayout ? visibleGridTerminalIds.indexOf(terminal.terminalId) : -1;
            const paneVisible = gridLayout ? gridIndex >= 0 : pane !== null;
            const otherId = pane === 'primary' ? secondaryTerminalId : primaryTerminalId;
            const options = terminals.filter((option) => option.terminalId === terminal.terminalId || option.terminalId !== otherId);
            const visiblePaneLabel = gridLayout ? `第${gridIndex + 1}个 Console` : pane ? paneLabel(pane) : undefined;
            return (
              <div
                className={`terminal-pane ${gridLayout ? `terminal-pane-grid terminal-pane-grid-${gridIndex + 1}` : pane ? `terminal-pane-${pane}` : 'terminal-pane-background'} ${paneVisible ? 'is-visible' : 'is-background'} ${focusedPane === pane || (gridLayout && focusedGridIndex === gridIndex) ? 'is-focused' : ''}`}
                key={terminal.terminalId}
                role={paneVisible ? 'region' : undefined}
                aria-label={visiblePaneLabel}
                onMouseDown={() => {
                  if (gridLayout && gridIndex >= 0) {
                    setFocusedGridIndex(gridIndex);
                    if (terminal.terminalId !== activeTerminalId) onActivate(terminal.terminalId);
                    return;
                  }
                  if (!pane) return;
                  setFocusedPane(pane);
                  if (terminal.terminalId !== activeTerminalId) onActivate(terminal.terminalId);
                }}
              >
                {paneVisible && (splitLayout || gridLayout) && (
                  <div className="terminal-pane-toolbar">
                    <span>{visiblePaneLabel}</span>
                    <label>
                      <span className="visually-hidden">{visiblePaneLabel}</span>
                      <select aria-label={visiblePaneLabel} value={terminal.terminalId} onChange={(event) => gridLayout ? selectGridTerminal(gridIndex, event.target.value) : pane ? selectPaneTerminal(pane, event.target.value) : undefined}>
                        {(gridLayout ? terminals.filter((option) => option.terminalId === terminal.terminalId || !visibleGridTerminalIds.includes(option.terminalId)) : options).map((option) => <option value={option.terminalId} key={option.terminalId}>{labelForTerminal(option.terminalId)}</option>)}
                      </select>
                    </label>
                  </div>
                )}
                {host ? <TerminalPanel key={terminal.terminalId} terminalId={terminal.terminalId} host={host} active={workspaceVisible && paneVisible} recoveryStatus={terminal.recoveryStatus} preferences={preferences} onClose={() => onClose(terminal.terminalId)} onEditHost={onEditHost} onStatusChange={(snapshot) => onStatusChange?.(terminal.terminalId, snapshot)} onToolbarChange={handleToolbarChange} /> : paneVisible && <div className="terminal-recovery-pane" role="status"><strong>Server 已不存在</strong><p>这个工作区标签关联的 Server 已不存在。</p><button className="button button-ghost button-small" type="button" onClick={() => onClose(terminal.terminalId)}>关闭标签</button></div>}
              </div>
            );
          })}
          {splitLayout && !secondaryTerminalId && (
            <div className="terminal-pane terminal-pane-secondary terminal-pane-empty is-visible" role="region" aria-label="右侧 Console" onMouseDown={() => setFocusedPane('secondary')}>
              <div className="terminal-pane-toolbar">
                <span>右侧 Console</span>
                <label>
                  <span className="visually-hidden">右侧 Console</span>
                  <select aria-label="右侧 Console" value="" onChange={(event) => selectPaneTerminal('secondary', event.target.value)}>
                    <option value="">选择 Console</option>
                    {terminals.filter((terminal) => terminal.terminalId !== primaryTerminalId).map((terminal) => <option value={terminal.terminalId} key={terminal.terminalId}>{labelForTerminal(terminal.terminalId)}</option>)}
                  </select>
                </label>
              </div>
              <div className="terminal-pane-empty-content"><span>等待第二个 Console</span>{onConnectHost && <button className="button button-ghost button-small" type="button" onClick={() => setHostPickerOpen(true)}>选择 Server</button>}</div>
            </div>
          )}
          {allowMultiPane && (splitLayout || gridLayout) && (
            <div
              className="terminal-divider"
              role="separator"
              tabIndex={0}
              aria-label={gridLayout ? '调整四格布局大小' : splitLayout?.orientation === 'horizontal' ? '调整左右分屏大小' : '调整上下分屏大小'}
              aria-orientation={gridLayout || splitLayout?.orientation !== 'horizontal' ? 'horizontal' : 'vertical'}
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(splitRatio * 100)}
              onKeyDown={updateSplitRatioFromKeyboard}
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setIsDraggingDivider(true); }}
              onPointerMove={updateSplitRatio}
              onPointerUp={stopDraggingDivider}
              onPointerCancel={stopDraggingDivider}
              onLostPointerCapture={stopDraggingDivider}
            />
          )}
        </div>
      </section>
      {filePanelOpen && onListSftp && activeHostId && <aside className="terminal-file-panel" aria-label="远程文件面板"><SftpPanel hostId={activeHostId} onList={onListSftp} onCreateDirectory={onCreateDirectorySftp ? (path) => onCreateDirectorySftp(activeHostId, path) : undefined} onRename={onRenameSftp ? (from, to) => onRenameSftp(activeHostId, from, to) : undefined} onDelete={onDeleteSftp ? (path) => onDeleteSftp(activeHostId, path) : undefined} onUpload={onUploadSftp ? (file, path) => onUploadSftp(activeHostId, file, path) : undefined} onDownload={onDownloadSftp ? (path, name) => onDownloadSftp(activeHostId, path, name) : undefined} /><TransferQueue jobs={transferJobs} onCancel={onCancelTransfer} onRetry={onRetryTransfer} /></aside>}
    </div>
  );
};
