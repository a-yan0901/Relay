import type { OperationDiagnostic, OperationNextAction, OperationStage } from '@shared/core/models';

export interface ConnectionStatusProps {
  label: string;
  tone?: 'neutral' | 'success' | 'danger';
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const operationStageLabels: Record<OperationStage, string> = {
  dns: '解析地址',
  tcp: '建立 TCP',
  'jump-host': '通过跳板',
  'host-key': '校验 Host Key',
  auth: '认证',
  pty: '打开终端',
  sftp: '文件传输',
  command: '执行命令'
};

export const operationNextActionLabels: Record<OperationNextAction, string> = {
  wait: '请稍候',
  retry: '重试',
  'edit-credentials': '编辑凭据',
  'confirm-host-key': '确认 Host Key',
  reopen: '重新打开',
  none: ''
};

export const operationDiagnosticLabel = (diagnostic: OperationDiagnostic | null | undefined): string | undefined => (
  diagnostic ? `${operationStageLabels[diagnostic.stage]} · ${operationNextActionLabels[diagnostic.nextAction] || '已结束'}` : undefined
);

export const ConnectionStatus = ({ label, tone = 'neutral', detail, actionLabel, onAction }: ConnectionStatusProps) => (
  <span className={`connection-status connection-status-${tone}`} role="status" aria-live="polite">
    <span className={`status-dot status-dot-${tone === 'success' ? 'green' : tone === 'danger' ? 'red' : 'blue'}`} aria-hidden="true" />
    <span>{label}</span>
    {detail && <small>{detail}</small>}
    {actionLabel && onAction && <button className="button button-ghost button-small" type="button" onClick={onAction}>{actionLabel}</button>}
  </span>
);
