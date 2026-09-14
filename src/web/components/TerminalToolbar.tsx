import type { TerminalStatus } from '@shared/protocol';

export interface TerminalToolbarProps {
  state: TerminalStatus;
  onReconnect: () => void;
  onClose: () => void;
  onClear: () => void;
  onNewTerminal?: () => void;
  onSearch?: () => void;
  onFullscreen?: () => void;
  searchActive?: boolean;
}

export const terminalStatusLabels: Record<TerminalStatus, string> = {
  connecting: '连接中',
  'awaiting-host-key': '等待确认',
  connected: '已连接',
  reconnecting: '重连中',
  closed: '已断开',
  failed: '连接失败'
};

export const terminalStatusDotClass = (state: TerminalStatus): string => {
  if (state === 'connected') return 'status-dot-green';
  if (state === 'failed') return 'status-dot-red';
  if (state === 'awaiting-host-key') return 'status-dot-amber';
  if (state === 'connecting' || state === 'reconnecting') return 'status-dot-blue';
  return 'status-dot-muted';
};

export const TerminalToolbar = ({
  state,
  onReconnect,
  onClose,
  onClear,
  onNewTerminal,
  onSearch,
  onFullscreen,
  searchActive = false
}: TerminalToolbarProps) => (
  <div className="terminal-toolbar">
    <div className="terminal-status"><span className={`status-dot ${terminalStatusDotClass(state)}`} />{terminalStatusLabels[state]}</div>
    <div className="terminal-toolbar-actions">
      {onNewTerminal && <button className="toolbar-button toolbar-button-new" type="button" aria-label="新建终端" onClick={onNewTerminal}>＋<span>新建终端</span></button>}
      {onSearch && <button className={`toolbar-button ${searchActive ? 'is-active' : ''}`} type="button" aria-label="搜索" onClick={onSearch}>⌕<span>搜索</span></button>}
      <button className="toolbar-button" type="button" aria-label="清屏" onClick={onClear}>清屏</button>
      {onFullscreen && <button className="toolbar-button" type="button" aria-label="全屏" onClick={onFullscreen}>⛶</button>}
      <button className="toolbar-button toolbar-button-reconnect" type="button" aria-label="重新连接" onClick={onReconnect}>↻<span>重连</span></button>
      <button className="toolbar-button toolbar-button-close" type="button" aria-label="关闭终端" onClick={onClose}>×</button>
    </div>
  </div>
);
