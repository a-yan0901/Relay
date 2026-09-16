import type { TerminalStatus } from '@shared/protocol';
import type { OperationDiagnostic } from '@shared/core/models';
import { ConnectionStatus, operationDiagnosticLabel } from './ConnectionStatus';

export interface TerminalToolbarProps {
  state: TerminalStatus;
  reconnectDelayMs?: number;
  diagnostic?: OperationDiagnostic | null;
  onReconnect: () => void;
  onClose: () => void;
  onClear: () => void;
  onSearch?: () => void;
  onFullscreen?: () => void;
  searchActive?: boolean;
  showStatus?: boolean;
}

export const terminalStatusLabels: Record<TerminalStatus, string> = {
  connecting: '连接中',
  'awaiting-host-key': '等待确认',
  'awaiting-credential': '等待凭据',
  connected: '已连接',
  reconnecting: '重连中',
  interrupted: '已中断',
  'needs-reopen': '需要重新连接',
  closed: '已断开',
  failed: '连接失败'
};

export const terminalStatusDotClass = (state: TerminalStatus): string => {
  if (state === 'connected') return 'status-dot-green';
  if (state === 'failed') return 'status-dot-red';
  if (state === 'awaiting-host-key') return 'status-dot-amber';
  if (state === 'awaiting-credential') return 'status-dot-amber';
  if (state === 'connecting' || state === 'reconnecting') return 'status-dot-blue';
  if (state === 'interrupted' || state === 'needs-reopen') return 'status-dot-amber';
  return 'status-dot-muted';
};

export const TerminalToolbar = ({
  state,
  reconnectDelayMs = 0,
  diagnostic = null,
  onReconnect,
  onClose,
  onClear,
  onSearch,
  onFullscreen,
  searchActive = false,
  showStatus = true
}: TerminalToolbarProps) => (
  <div className="terminal-toolbar">
    {showStatus && <ConnectionStatus
      label={terminalStatusLabels[state]}
      tone={state === 'connected' ? 'success' : state === 'failed' ? 'danger' : 'neutral'}
      detail={state === 'reconnecting' && reconnectDelayMs > 0
        ? `约 ${Math.max(1, Math.ceil(reconnectDelayMs / 1_000))} 秒后自动重试`
        : operationDiagnosticLabel(diagnostic)}
    />}
    <div className="terminal-toolbar-actions">
      {onSearch && <button className={`toolbar-button ${searchActive ? 'is-active' : ''}`} type="button" aria-label="搜索" onClick={onSearch}>⌕<span>搜索</span></button>}
      <button className="toolbar-button" type="button" aria-label="清屏" onClick={onClear}>⌫<span>清屏</span></button>
      {onFullscreen && <button className="toolbar-button" type="button" aria-label="全屏" onClick={onFullscreen}>⛶</button>}
      <button className="toolbar-button toolbar-button-reconnect" type="button" aria-label="重新连接" onClick={onReconnect}>↻<span>重连</span></button>
      <button className="toolbar-button toolbar-button-close" type="button" aria-label="关闭终端" onClick={onClose}>×</button>
    </div>
  </div>
);
