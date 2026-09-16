import { useMemo } from 'react';

import type { BroadcastTargetSnapshot } from '../../shared/core/models';
import type { TerminalStatus } from '../../shared/protocol';
import type { HostMetadataState, GroupSummary, TerminalTabState } from '../state/app-state';
import { createBroadcastTargetSnapshot } from '../../shared/core/target-selection';
import { Dialog } from './Dialog';

export interface BroadcastPreviewProps {
  workspaceId: string | null;
  hosts: readonly HostMetadataState[];
  groups: readonly GroupSummary[];
  terminals: readonly TerminalTabState[];
  workspaceTabIdByTerminalId?: Readonly<Record<string, string>>;
  onConfirm: (snapshot: BroadcastTargetSnapshot) => void;
  onClose: () => void;
}

const writableStates: readonly TerminalStatus[] = ['connected'];

export const BroadcastPreview = ({
  workspaceId,
  hosts,
  groups,
  terminals,
  workspaceTabIdByTerminalId = {},
  onConfirm,
  onClose
}: BroadcastPreviewProps) => {
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const writableTargets = useMemo(() => terminals
    .filter((terminal) => writableStates.includes(terminal.state) && terminal.recoveryStatus !== 'missing-host' && terminal.recoveryStatus !== 'needs-reopen')
    .map((terminal) => ({ terminal, host: hostById.get(terminal.hostId) }))
    .filter((target): target is { terminal: TerminalTabState; host: HostMetadataState } => target.host !== undefined), [hostById, terminals]);
  const writableHostIds = useMemo(() => [...new Set(writableTargets.map(({ host }) => host.id))], [writableTargets]);
  const canBroadcast = writableHostIds.length >= 2;

  const confirm = (): void => {
    if (!canBroadcast) return;
    onConfirm(createBroadcastTargetSnapshot({
      workspaceId,
      tabIds: writableTargets.map(({ terminal }) => workspaceTabIdByTerminalId[terminal.terminalId] ?? terminal.terminalId),
      hostIds: writableHostIds
    }));
  };

  return (
    <Dialog title="广播执行预览" ariaLabel="广播执行预览" onClose={onClose} initialFocusSelector="#broadcast-confirm" className="broadcast-preview-dialog">
      <p className="dialog-copy">先确认当前 Workspace 中可写的 Console，再填写命令。提交后目标快照不会随 tab 的增删变化。</p>
      <div className="broadcast-preview-summary" role="status" aria-live="polite">
        <strong>{writableTargets.length} 个可写 Console</strong>
        <span>{writableHostIds.length} 台 Server · {canBroadcast ? '可以广播' : '至少需要两个可写 Console'}</span>
      </div>
      <div className="broadcast-preview-list" role="list" aria-label="广播目标">
        {writableTargets.map(({ terminal, host }) => <div className="broadcast-preview-item" role="listitem" key={terminal.terminalId}>
          <span className="status-dot status-dot-green" aria-hidden="true" />
          <span className="broadcast-preview-item-main"><strong>{host.name}</strong><small><span>{host.username}</span> · {host.address}:{host.port} · SSH · {host.authType === 'private_key' ? '私钥认证' : '密码认证'}</small></span>
          <span className="broadcast-preview-item-context">{host.groupId ? `环境：${groupById.get(host.groupId) ?? '未分组'}` : '未分组'}</span>
        </div>)}
        {writableTargets.length === 0 && <p className="quick-switcher-empty">当前没有可写 Console</p>}
      </div>
      <div className="broadcast-preview-details" aria-label="广播执行设置">
        <div><strong>命令范围</strong><span>当前列出的可写 Console</span></div>
        <div><strong>风险</strong><span className={canBroadcast ? 'broadcast-risk-high' : ''}>{canBroadcast ? '高风险：多会话广播' : '不可用'}</span></div>
        <div><strong>并发</strong><span>并发 4（下一步可调整）</span></div>
        <div><strong>停止</strong><span>执行中可从结果面板取消</span></div>
      </div>
      <div className="dialog-actions">
        <button className="button button-ghost" type="button" onClick={onClose}>取消</button>
        <button className="button button-primary" id="broadcast-confirm" type="button" disabled={!canBroadcast} onClick={confirm}>确认并填写命令</button>
      </div>
    </Dialog>
  );
};
