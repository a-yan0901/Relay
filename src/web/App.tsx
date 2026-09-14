import { useCallback, useEffect, useReducer, useState } from 'react';

import { AppError } from '@shared/errors';
import type { HostCreateInput } from '@shared/validation';

import {
  createHost,
  getSetupStatus,
  listGroups,
  listHosts,
  lockVault,
  setupVault,
  unlockVault,
  updateHost
} from './api';
import { HostForm } from './components/HostForm';
import { HostWorkspace } from './components/HostWorkspace';
import { SetupGate } from './components/SetupGate';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { UnlockView } from './components/UnlockView';
import type { TerminalSessionSnapshot } from './hooks/use-terminal-session';
import { appReducer, initialAppState, type HostMetadataState } from './state/app-state';

const messageFromError = (error: unknown): string => (
  error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试'
);

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

const WorkspaceHeader = ({ onLock, terminalCount, onOpenTerminals }: { onLock: () => void; terminalCount: number; onOpenTerminals: () => void }) => (
  <header className="app-header">
    <Brand />
    <div className="app-header-actions">
      <span className="secure-pill"><span className="status-dot status-dot-green" />Vault 已解锁</span>
      <button className="button button-ghost button-small" type="button" onClick={onLock}>
        <span aria-hidden="true">↥</span> 锁定
      </button>
      {terminalCount > 0 && <button className="button button-ghost button-small" type="button" onClick={onOpenTerminals}>终端 <span className="header-count">{terminalCount}</span></button>}
      <span className="avatar" aria-label="本地用户">L</span>
    </div>
  </header>
);

export const App = () => {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [terminalView, setTerminalView] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    try {
      const [hosts, groups] = await Promise.all([listHosts(), listGroups()]);
      dispatch({ type: 'hostsLoaded', hosts });
      dispatch({ type: 'groupsLoaded', groups });
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
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'error', message: messageFromError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [bootAttempt, loadWorkspace]);

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
    const host = await createHost(input);
    dispatch({ type: 'hostCreated', host });
    setHostFormOpen(false);
  };

  const handleFavoriteToggle = async (host: HostMetadataState): Promise<void> => {
    const nextFavorite = !host.isFavorite;
    dispatch({ type: 'favoriteOptimistic', hostId: host.id, isFavorite: nextFavorite });
    try {
      const updated = await updateHost(host.id, { isFavorite: nextFavorite });
      dispatch({ type: 'hostUpdated', host: updated });
      dispatch({ type: 'favoriteRollback', hostId: host.id });
    } catch (error) {
      dispatch({ type: 'favoriteRollback', hostId: host.id });
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleOpenTerminal = (host: HostMetadataState): void => {
    dispatch({ type: 'terminalOpened', terminalId: createTerminalId(), hostId: host.id });
    setTerminalView(true);
  };

  const handleCloseTerminal = (terminalId: string): void => {
    dispatch({ type: 'terminalClosed', terminalId });
    if (state.terminals.length <= 1) setTerminalView(false);
  };

  const handleTerminalStatus = (terminalId: string, snapshot: TerminalSessionSnapshot): void => {
    dispatch({
      type: 'terminalStatusUpdated',
      terminalId,
      state: snapshot.state,
      reconnectDelayMs: snapshot.reconnectDelayMs,
      errorMessage: snapshot.error?.message ?? null
    });
  };

  const handleLock = async (): Promise<void> => {
    try {
      await lockVault();
      dispatch({ type: 'lock' });
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  if (state.phase === 'loading') return <LoadingView errorMessage={state.errorMessage} onRetry={retryBoot} />;
  if (state.phase === 'setup') return <SetupGate onSubmit={completeSetup} errorMessage={state.errorMessage} />;
  if (state.phase === 'locked') return <UnlockView onSubmit={completeUnlock} errorMessage={state.errorMessage} />;

  return (
    <main className="app-shell">
      <WorkspaceHeader onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} />
      {state.errorMessage && (
        <div className="global-alert" role="alert">
          <span>{state.errorMessage}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => dispatch({ type: 'error', message: null })}>×</button>
        </div>
      )}
      <div className="app-body">
        {terminalView ? (
          <TerminalWorkspace
            hosts={state.hosts}
            terminals={state.terminals}
            activeTerminalId={state.activeTerminalId}
            onActivate={(terminalId) => dispatch({ type: 'terminalActivated', terminalId })}
            onClose={handleCloseTerminal}
            onConnectHost={handleOpenTerminal}
            onStatusChange={handleTerminalStatus}
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
            onAddHost={() => setHostFormOpen(true)}
          />
        )}
      </div>
      {hostFormOpen && (
        <div className="drawer-backdrop" role="presentation">
          <aside className="drawer" aria-label="添加 Server">
            <HostForm onSubmit={handleCreateHost} onCancel={() => setHostFormOpen(false)} />
          </aside>
        </div>
      )}
      <div className="app-watermark" aria-hidden="true">LOCAL-FIRST · ENCRYPTED BY DEFAULT</div>
    </main>
  );
};
