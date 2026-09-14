import type { TerminalStatus } from '@shared/protocol';

export interface TerminalToolbarProps {
  state: TerminalStatus;
  onReconnect: () => void;
  onClose: () => void;
  onClear: () => void;
  onSearch?: () => void;
  onFullscreen?: () => void;
  searchActive?: boolean;
}

const labels: Record<TerminalStatus, string> = {
  connecting: '连接中',
  'awaiting-host-key': '等待确认',
  connected: '已连接',
  reconnecting: '重连中',
  closed: '已断开',
  failed: '连接失败'
};

export const TerminalToolbar = ({
  state,
  onReconnect,
  onClose,
  onClear,
  onSearch,
  onFullscreen,
  searchActive = false
}: TerminalToolbarProps) => (
  <div className="terminal-toolbar">
    <div className="terminal-status"><span className={`status-dot ${state === 'connected' ? 'status-dot-green' : state === 'failed' ? 'status-dot-red' : 'status-dot-muted'}`} />{labels[state]}</div>
    <div className="terminal-toolbar-actions">
      {onSearch && <button className={`toolbar-button ${searchActive ? 'is-active' : ''}`} type="button" aria-label="搜索" onClick={onSearch}>⌕<span>搜索</span></button>}
      <button className="toolbar-button" type="button" aria-label="清屏" onClick={onClear}>清屏</button>
      {onFullscreen && <button className="toolbar-button" type="button" aria-label="全屏" onClick={onFullscreen}>⛶</button>}
      <button className="toolbar-button toolbar-button-reconnect" type="button" aria-label="重新连接" onClick={onReconnect}>↻<span>重连</span></button>
      <button className="toolbar-button toolbar-button-close" type="button" aria-label="关闭终端" onClick={onClose}>×</button>
    </div>
  </div>
);
