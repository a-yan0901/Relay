import { useMemo, useState } from 'react';

import type { HostMetadataState, TerminalTabState } from '../state/app-state';
import { TerminalPanel } from './TerminalPanel';

export interface TerminalWorkspaceProps {
  hosts?: HostMetadataState[];
  terminals: TerminalTabState[];
  activeTerminalId: string | null;
  onActivate: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onConnectHost?: (host: HostMetadataState) => void;
  onBackToHosts?: () => void;
}

export const TerminalWorkspace = ({
  hosts = [],
  terminals,
  activeTerminalId,
  onActivate,
  onClose,
  onConnectHost,
  onBackToHosts
}: TerminalWorkspaceProps) => {
  const [hostQuery, setHostQuery] = useState('');
  const visibleHosts = useMemo(() => {
    const normalized = hostQuery.trim().toLowerCase();
    return hosts.filter((host) => !normalized || `${host.name} ${host.address} ${host.username}`.toLowerCase().includes(normalized));
  }, [hostQuery, hosts]);

  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const activeHost = terminals.find((terminal) => terminal.terminalId === activeTerminalId);

  if (terminals.length === 0) {
    return (
      <section className="terminal-empty-state" aria-label="终端工作区">
        <div className="empty-state-illustration" aria-hidden="true">⌁</div>
        <p className="eyebrow">TERMINAL WORKSPACE</p>
        <h1>选择一台 Server 开始连接</h1>
        <p>打开终端后，你可以在这里切换多个 SSH 会话。</p>
        {onBackToHosts && <button className="button button-primary" type="button" onClick={onBackToHosts}>返回 Server 列表</button>}
      </section>
    );
  }

  return (
    <div className="terminal-workspace-shell">
      <aside className="terminal-host-rail" aria-label="终端 Server 列表">
        <button className="back-to-hosts" type="button" onClick={onBackToHosts}>← Server 列表</button>
        <div className="terminal-rail-heading"><p className="sidebar-label">已打开终端</p><span>{terminals.length}</span></div>
        <div className="terminal-rail-tabs">
          {terminals.map((terminal) => {
            const host = hostById.get(terminal.hostId);
            if (!host) return null;
            return <button className={`rail-tab ${terminal.terminalId === activeTerminalId ? 'is-active' : ''}`} type="button" key={terminal.terminalId} onClick={() => onActivate(terminal.terminalId)}><span className="status-dot status-dot-green" /><span>{host.name}</span></button>;
          })}
        </div>
        {onConnectHost && <>
          <div className="terminal-rail-heading terminal-rail-heading-spaced"><p className="sidebar-label">连接另一台</p></div>
          <label className="rail-search" htmlFor="terminal-host-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索 Server</span><input id="terminal-host-search" aria-label="搜索 Server" value={hostQuery} onChange={(event) => setHostQuery(event.target.value)} placeholder="搜索 Server" /></label>
          <div className="rail-hosts">
            {visibleHosts.map((host) => <button type="button" key={host.id} onClick={() => onConnectHost(host)}>{host.name}<small>{host.username}@{host.address}</small></button>)}
          </div>
        </>}
        {activeHost && <div className="terminal-rail-footer">活动会话<br /><strong>{hostById.get(activeHost.hostId)?.name ?? 'Server'}</strong></div>}
      </aside>
      <section className="terminal-main" aria-label="终端标签工作区">
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {terminals.map((terminal) => {
            const host = hostById.get(terminal.hostId);
            if (!host) return null;
            return (
              <button className={`terminal-tab ${terminal.terminalId === activeTerminalId ? 'is-active' : ''}`} type="button" role="tab" aria-selected={terminal.terminalId === activeTerminalId} aria-label={`切换 ${host.name}`} key={terminal.terminalId} onClick={() => onActivate(terminal.terminalId)}>
                <span className="status-dot status-dot-green" /><span className="terminal-tab-meta"><strong>{host.name}</strong><small>{host.username}@{host.address}</small></span><span className="tab-close" aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
        <div className="terminal-panels">
          {terminals.map((terminal) => {
            const host = hostById.get(terminal.hostId);
            if (!host) return null;
            return <TerminalPanel key={terminal.terminalId} terminalId={terminal.terminalId} host={host} active={terminal.terminalId === activeTerminalId} onClose={() => onClose(terminal.terminalId)} />;
          })}
        </div>
      </section>
    </div>
  );
};
