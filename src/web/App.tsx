import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { AppError } from '@shared/errors';
import type { HostCreateInput, HostPatchInput } from '@shared/validation';

import {
  createHost,
  deleteHost,
  getSetupStatus,
  listGroups,
  listHosts,
  lockVault,
  setupVault,
  testConnection,
  unlockVault,
  updateHost
} from './api';
import { HostForm } from './components/HostForm';
import { HostWorkspace } from './components/HostWorkspace';
import { SetupGate } from './components/SetupGate';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { UnlockView } from './components/UnlockView';
import type { TerminalSessionSnapshot } from './hooks/use-terminal-session';
import { useDialogFocus } from './hooks/use-dialog-focus';
import {
  appReducer,
  clearTerminalDescriptors,
  initialAppState,
  loadTerminalDescriptors,
  saveTerminalDescriptors,
  type HostMetadataState
} from './state/app-state';
import {
  applyPreferences,
  fontSizeOptions,
  loadPreferences,
  savePreferences,
  themeOptions,
  type TerminalFontSize,
  type ThemeName,
  type UiPreferences
} from './theme';

const messageFromError = (error: unknown): string => (
  error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试'
);

type ConnectionFeedback = {
  tone: 'success' | 'info';
  message: string;
};

const createTerminalId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `terminal-${globalThis.crypto.randomUUID()}`;
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const LoadingView = ({ errorMessage, onRetry }: { errorMessage: string | null; onRetry: () => void }) => (
  <main className="center-stage" aria-label="正在加载 Web SSH">
    <div className="loading-card">
      <span className="brand-mark" aria-hidden="true">⌁</span>
      <p className="eyebrow">SECURE WORKSPACE</p>
      <h1>{errorMessage ? '工作区暂时无法加载' : '正在准备工作区'}</h1>
      {errorMessage ? <><p className="form-error" role="alert">{errorMessage}</p><button className="button button-primary" type="button" onClick={onRetry}>重试</button></> : <span className="loading-line" aria-hidden="true" />}
    </div>
  </main>
);

const Brand = () => (
  <div className="brand-lockup">
    <span className="brand-mark" aria-hidden="true">⌁</span>
    <span>
      <strong>Relay</strong>
      <small>WEB SSH WORKSPACE</small>
    </span>
  </div>
);

const WorkspaceHeader = ({ onLock, terminalCount, onOpenTerminals, onSettings, terminalView }: { onLock: () => void; terminalCount: number; onOpenTerminals: () => void; onSettings: () => void; terminalView: boolean }) => (
  <header className={`app-header ${terminalView ? 'app-header-terminal' : ''}`}>
    <Brand />
    <div className="app-header-actions">
      <span className="secure-pill"><span className="status-dot status-dot-green" />Vault 已解锁</span>
      <button className="button button-ghost button-small" type="button" onClick={onLock}>
        <span aria-hidden="true">↥</span> 锁定
      </button>
      {terminalCount > 0 && !terminalView && <button className="button button-ghost button-small" type="button" onClick={onOpenTerminals}>终端 <span className="header-count">{terminalCount}</span></button>}
      <button className="button button-ghost button-small" type="button" aria-label="偏好设置" onClick={onSettings}>⚙<span className="settings-label">偏好</span></button>
      <span className="avatar" aria-label="本地用户">L</span>
    </div>
  </header>
);

const PreferencesPanel = ({ preferences, onChange, onClose }: { preferences: UiPreferences; onChange: (preferences: UiPreferences) => void; onClose: () => void }) => {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, true, onClose, '#theme-select');

  return (
  <div className="preferences-backdrop" role="presentation" onMouseDown={onClose}>
    <aside ref={dialogRef} className="preferences-panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="form-heading">
        <div><p className="eyebrow">WORKSPACE PREFERENCES</p><h2 id="preferences-title">偏好设置</h2></div>
        <button className="icon-button" type="button" aria-label="关闭偏好设置" onClick={onClose}>×</button>
      </div>
      <div className="preferences-fields">
        <label htmlFor="theme-select">色彩主题</label>
        <select id="theme-select" aria-label="色彩主题" value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as ThemeName })}>
          {themeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
        <label htmlFor="font-size-select">终端字号</label>
        <select id="font-size-select" aria-label="终端字号" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) as TerminalFontSize })}>
          {fontSizeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </div>
      <p className="preferences-note">偏好只保存在当前浏览器，不包含主密码、服务器密码或私钥。</p>
    </aside>
  </div>
  );
};

export const App = () => {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<HostMetadataState | null>(null);
  const [terminalView, setTerminalView] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadPreferences());
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const refreshedHostForTerminalRef = useRef(new Set<string>());
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionFeedback | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    applyPreferences(preferences);
    savePreferences(preferences);
  }, [preferences]);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    try {
      const [hosts, groups] = await Promise.all([listHosts(), listGroups()]);
      dispatch({ type: 'hostsLoaded', hosts });
      dispatch({ type: 'groupsLoaded', groups });
      const availableHostIds = new Set(hosts.map((host) => host.id));
      const restored = loadTerminalDescriptors().filter((descriptor) => availableHostIds.has(descriptor.hostId));
      saveTerminalDescriptors(restored);
      restored.forEach((descriptor) => dispatch({ type: 'terminalOpened', terminalId: descriptor.terminalId, hostId: descriptor.hostId }));
      if (restored.length > 0) setTerminalView(true);
      setWorkspaceHydrated(true);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSetupStatus()
      .then((status) => {
        if (cancelled) return;
        dispatch({ type: 'setup', initialized: status.initialized, locked: status.locked });
        if (status.initialized && !status.locked) {
          void loadWorkspace();
        } else if (!status.initialized) {
          clearTerminalDescriptors();
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'error', message: messageFromError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [bootAttempt, loadWorkspace]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready') return;
    saveTerminalDescriptors(state.terminals.map(({ terminalId, hostId }) => ({ terminalId, hostId })));
  }, [state.phase, state.terminals, workspaceHydrated]);

  const retryBoot = (): void => {
    dispatch({ type: 'error', message: null });
    setBootAttempt((attempt) => attempt + 1);
  };

  const completeSetup = async (masterPassword: string): Promise<void> => {
    try {
      await setupVault(masterPassword);
      dispatch({ type: 'setup', initialized: true, locked: false });
      await loadWorkspace();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const completeUnlock = async (masterPassword: string): Promise<void> => {
    try {
      await unlockVault(masterPassword);
      dispatch({ type: 'unlock' });
      await loadWorkspace();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleCreateHost = async (input: HostCreateInput): Promise<void> => {
    try {
      const host = await createHost(input);
      dispatch({ type: 'hostCreated', host });
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleUpdateHost = async (input: HostPatchInput): Promise<void> => {
    if (!editingHost) return;
    try {
      const host = await updateHost(editingHost.id, input);
      dispatch({ type: 'hostUpdated', host });
      setEditingHost(null);
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleFavoriteToggle = async (host: HostMetadataState): Promise<void> => {
    const nextFavorite = !host.isFavorite;
    dispatch({ type: 'favoriteOptimistic', hostId: host.id, isFavorite: nextFavorite });
    try {
      const updated = await updateHost(host.id, { isFavorite: nextFavorite });
      dispatch({ type: 'hostUpdated', host: updated });
      dispatch({ type: 'favoriteCommitted', hostId: host.id });
    } catch (error) {
      dispatch({ type: 'favoriteRollback', hostId: host.id });
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleOpenTerminal = (host: HostMetadataState): void => {
    dispatch({ type: 'terminalOpened', terminalId: createTerminalId(), hostId: host.id });
    setTerminalView(true);
  };

  const handleDeleteHost = async (host: HostMetadataState): Promise<void> => {
    if (!window.confirm(`确定删除 Server「${host.name}」吗？`)) return;
    try {
      await deleteHost(host.id);
      const remainingTerminals = state.terminals.filter((terminal) => terminal.hostId !== host.id);
      dispatch({ type: 'hostDeleted', hostId: host.id });
      saveTerminalDescriptors(remainingTerminals.map(({ terminalId, hostId }) => ({ terminalId, hostId })));
      if (state.terminals.length > 0 && remainingTerminals.length === 0) setTerminalView(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleTestConnection = async (host: HostMetadataState): Promise<void> => {
    setConnectionFeedback(null);
    try {
      const result = await testConnection(host.id);
      if (result.ok) {
        dispatch({ type: 'error', message: null });
        setConnectionFeedback({ tone: 'success', message: `连接测试成功：${host.name}` });
      } else if (result.hostKey) {
        dispatch({ type: 'error', message: null });
        setConnectionFeedback({ tone: 'info', message: `需要确认远程主机指纹：${result.hostKey.fingerprint}` });
      } else {
        dispatch({ type: 'error', message: `无法连接：${host.name}` });
      }
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const openCreateHost = (): void => {
    setEditingHost(null);
    setHostFormOpen(true);
  };

  const openEditHost = (host: HostMetadataState): void => {
    setEditingHost(host);
    setHostFormOpen(true);
  };

  const closeHostForm = (): void => {
    setEditingHost(null);
    setHostFormOpen(false);
  };

  useDialogFocus(drawerRef, hostFormOpen, closeHostForm, '#host-name');

  const handleCloseTerminal = (terminalId: string): void => {
    dispatch({ type: 'terminalClosed', terminalId });
    saveTerminalDescriptors(loadTerminalDescriptors().filter((descriptor) => descriptor.terminalId !== terminalId));
    if (state.terminals.length <= 1) setTerminalView(false);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const target = event.target;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      const isTerminalInput = target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea');
      const isTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (isTextEntry && !(isTerminalInput && (key === 'k' || key === 'w'))) return;
      if (key === 'k') {
        event.preventDefault();
        if (terminalView) {
          const terminalSearch = document.getElementById('terminal-host-search');
          if (terminalSearch) terminalSearch.focus();
          else document.getElementById('terminal-new-terminal')?.click();
        } else {
          document.getElementById('host-search')?.focus();
        }
      } else if (key === 'w' && terminalView && state.activeTerminalId) {
        event.preventDefault();
        handleCloseTerminal(state.activeTerminalId);
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [state.activeTerminalId, terminalView]);

  const handleTerminalStatus = (terminalId: string, snapshot: TerminalSessionSnapshot): void => {
    dispatch({
      type: 'terminalStatusUpdated',
      terminalId,
      state: snapshot.state,
      reconnectDelayMs: snapshot.reconnectDelayMs,
      errorMessage: snapshot.error?.message ?? null
    });
    if (snapshot.state !== 'connected') {
      refreshedHostForTerminalRef.current.delete(terminalId);
      return;
    }
    if (refreshedHostForTerminalRef.current.has(terminalId)) return;
    refreshedHostForTerminalRef.current.add(terminalId);
    void listHosts()
      .then((hosts) => dispatch({ type: 'hostsLoaded', hosts }))
      .catch(() => {
        refreshedHostForTerminalRef.current.delete(terminalId);
      });
  };

  const handleLock = async (): Promise<void> => {
    try {
      await lockVault();
      dispatch({ type: 'lock' });
      clearTerminalDescriptors();
      setTerminalView(false);
      closeHostForm();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  if (state.phase === 'loading') return <LoadingView errorMessage={state.errorMessage} onRetry={retryBoot} />;
  if (state.phase === 'setup') return <SetupGate onSubmit={completeSetup} errorMessage={state.errorMessage} />;
  if (state.phase === 'locked') return <UnlockView onSubmit={completeUnlock} errorMessage={state.errorMessage} />;

  return (
    <main className="app-shell">
      <WorkspaceHeader onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} onSettings={() => setPreferencesOpen(true)} terminalView={terminalView} />
      {state.errorMessage && (
        <div className="global-alert" role="alert">
          <span>{state.errorMessage}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => dispatch({ type: 'error', message: null })}>×</button>
        </div>
      )}
      {connectionFeedback && (
        <div className={`global-feedback global-feedback-${connectionFeedback.tone}`} role="status" aria-live="polite">
          <span>{connectionFeedback.message}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => setConnectionFeedback(null)}>×</button>
        </div>
      )}
      <div className={`app-body ${terminalView ? 'app-body-terminal' : ''}`}>
        {terminalView ? (
          <TerminalWorkspace
            hosts={state.hosts}
            terminals={state.terminals}
            activeTerminalId={state.activeTerminalId}
            onActivate={(terminalId) => dispatch({ type: 'terminalActivated', terminalId })}
            onClose={handleCloseTerminal}
            onConnectHost={handleOpenTerminal}
            onStatusChange={handleTerminalStatus}
            preferences={preferences}
            onBackToHosts={() => setTerminalView(false)}
          />
        ) : (
          <HostWorkspace
            hosts={state.hosts}
            groups={state.groups}
            query={state.query}
            selectedGroupId={state.selectedGroupId}
            favoriteOnly={state.favoriteOnly}
            onQueryChange={(query) => dispatch({ type: 'queryChanged', query })}
            onGroupSelected={(groupId) => dispatch({ type: 'groupSelected', groupId })}
            onFavoriteFilter={(favoriteOnly) => dispatch({ type: 'favoriteFilterChanged', favoriteOnly })}
            onFavoriteToggle={(host) => void handleFavoriteToggle(host)}
            onConnect={handleOpenTerminal}
            onAddHost={openCreateHost}
            onEdit={openEditHost}
            onDelete={(host) => void handleDeleteHost(host)}
            onTestConnection={(host) => void handleTestConnection(host)}
          />
        )}
      </div>
      {hostFormOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHostForm(); }}>
          <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="host-form-title" onMouseDown={(event) => event.stopPropagation()}>
            {editingHost ? <HostForm mode="edit" initialHost={editingHost} groups={state.groups} onEditSubmit={handleUpdateHost} onCancel={closeHostForm} /> : <HostForm groups={state.groups} onSubmit={handleCreateHost} onCancel={closeHostForm} />}
          </aside>
        </div>
      )}
      {preferencesOpen && <PreferencesPanel preferences={preferences} onChange={setPreferences} onClose={() => setPreferencesOpen(false)} />}
      <div className="app-watermark" aria-hidden="true">LOCAL-FIRST · ENCRYPTED BY DEFAULT</div>
    </main>
  );
};
