import { useEffect, useState } from 'react';

import { activityStatusFromEvent, type ActivityFilter, type ActivityStatus, type AuditEvent, type OperationDiagnostic } from '../../shared/core/models';
import { operationStageLabels, operationNextActionLabels } from './ConnectionStatus';

interface ActivityHostOption {
  id: string;
  name: string;
}

export interface ActivityPanelProps {
  events: readonly AuditEvent[];
  expiredRunIds?: ReadonlySet<string>;
  onOpenRun?: (runId: string) => void;
  diagnostics?: readonly OperationDiagnostic[];
  hosts?: readonly ActivityHostOption[];
  filter?: ActivityFilter;
  loading?: boolean;
  hasMore?: boolean;
  onApplyFilter?: (filter: ActivityFilter) => void;
  onLoadMore?: () => void;
  onClose?: () => void;
}

const DEFAULT_ACTIVITY_FILTER: ActivityFilter = { limit: 50 };

const activityStatusLabels: Record<ActivityStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

interface ActivityDraft {
  eventType: string;
  hostId: string;
  requestId: string;
  status: ActivityStatus | '';
  from: string;
  to: string;
}

const datePart = (value: string | undefined): string => value?.slice(0, 10) ?? '';

const draftFromFilter = (filter: ActivityFilter): ActivityDraft => ({
  eventType: filter.eventType ?? '',
  hostId: filter.hostId ?? '',
  requestId: filter.requestId ?? '',
  status: filter.status ?? '',
  from: datePart(filter.from),
  to: datePart(filter.to)
});

const eventLabel = (event: AuditEvent): string => {
  if (event.eventType === 'command_run_summary') {
    const numericMetadata = (key: string): number => typeof event.metadata[key] === 'number' ? event.metadata[key] as number : 0;
    const targetCount = numericMetadata('targetCount');
    const successCount = numericMetadata('successCount');
    const failureCount = numericMetadata('failureCount');
    const cancelledCount = numericMetadata('cancelledCount');
    const interruptedCount = numericMetadata('interruptedCount');
    const anomaly = cancelledCount + interruptedCount;
    return `批量任务 · ${targetCount} 台主机 · ${successCount} 成功 / ${failureCount} 失败${anomaly > 0 ? ` · ${anomaly} 异常` : ''}`;
  }
  if (event.eventType.startsWith('connection_')) return event.eventType === 'connection_succeeded' ? '连接成功' : '连接失败';
  if (event.eventType.startsWith('sftp_')) return event.eventType.replaceAll('_', ' ');
  return event.eventType.replaceAll('_', ' ');
};

const diagnosticStateLabels: Record<OperationDiagnostic['state'], string> = {
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  'needs-reopen': '需要重新打开'
};

const diagnosticDetail = (diagnostic: OperationDiagnostic | undefined): string => {
  if (!diagnostic) return '';
  const action = diagnostic.nextAction === 'none' ? '' : ` · ${operationNextActionLabels[diagnostic.nextAction]}`;
  return ` · ${operationStageLabels[diagnostic.stage]} · ${diagnosticStateLabels[diagnostic.state]}${action}`;
};

export const ActivityPanel = ({
  events,
  expiredRunIds = new Set<string>(),
  onOpenRun,
  diagnostics = [],
  hosts = [],
  filter = DEFAULT_ACTIVITY_FILTER,
  loading = false,
  hasMore = false,
  onApplyFilter,
  onLoadMore,
  onClose
}: ActivityPanelProps) => {
  const [draft, setDraft] = useState<ActivityDraft>(() => draftFromFilter(filter));
  const diagnosticByOperationId = new Map(diagnostics.map((diagnostic) => [diagnostic.operationId, diagnostic]));
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));

  useEffect(() => {
    setDraft(draftFromFilter(filter));
  }, [filter]);

  const updateDraft = <K extends keyof ActivityDraft>(key: K, value: ActivityDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const applyFilter = (): void => {
    const next: ActivityFilter = { limit: filter.limit ?? 50 };
    if (draft.eventType) next.eventType = draft.eventType.trim();
    if (draft.hostId) next.hostId = draft.hostId;
    if (draft.requestId.trim()) next.requestId = draft.requestId.trim();
    if (draft.status) next.status = draft.status;
    if (draft.from) next.from = `${draft.from}T00:00:00.000Z`;
    if (draft.to) next.to = `${draft.to}T23:59:59.999Z`;
    onApplyFilter?.(next);
  };

  return (
    <section className="activity-panel" aria-label="最近活动" aria-busy={loading}>
      <div className="form-heading"><div><p className="eyebrow">ACTIVITY</p><h2>最近活动</h2></div>{onClose && <button className="icon-button" type="button" aria-label="关闭最近活动" title="关闭最近活动" onClick={onClose}>×</button>}</div>
      <div className="activity-filters" aria-label="活动筛选">
        <label>类型<input aria-label="筛选活动类型" value={draft.eventType} onChange={(event) => updateDraft('eventType', event.target.value)} placeholder="例如 command_run_summary" /></label>
        <label>状态<select aria-label="筛选活动状态" value={draft.status} onChange={(event) => updateDraft('status', event.target.value as ActivityStatus | '')}><option value="">全部状态</option>{(Object.keys(activityStatusLabels) as ActivityStatus[]).map((status) => <option value={status} key={status}>{activityStatusLabels[status]}</option>)}</select></label>
        <label>主机<select aria-label="筛选活动主机" value={draft.hostId} onChange={(event) => updateDraft('hostId', event.target.value)}><option value="">全部主机</option>{hosts.map((host) => <option value={host.id} key={host.id}>{host.name}</option>)}</select></label>
        <label>请求 ID<input aria-label="活动请求 ID" value={draft.requestId} onChange={(event) => updateDraft('requestId', event.target.value)} placeholder="精确匹配" /></label>
        <label>开始日期<input aria-label="活动开始日期" type="date" value={draft.from} onChange={(event) => updateDraft('from', event.target.value)} /></label>
        <label>结束日期<input aria-label="活动结束日期" type="date" value={draft.to} onChange={(event) => updateDraft('to', event.target.value)} /></label>
        <button className="button button-primary button-small" type="button" onClick={applyFilter}>应用筛选</button>
      </div>
      {events.length === 0
        ? <p className="sftp-empty-state">{loading ? '加载活动中…' : '暂无活动'}</p>
        : <ul>{events.map((event) => {
          const runId = typeof event.metadata.runId === 'string' ? event.metadata.runId : undefined;
          const expired = runId !== undefined && expiredRunIds.has(runId);
          const diagnostic = runId ? diagnosticByOperationId.get(runId) : undefined;
          const hostLabel = event.hostId ? ` · ${hostNames.get(event.hostId) ?? event.hostId}` : '';
          const status = activityStatusFromEvent(event);
          return (
            <li key={event.id} className="activity-item">
              <div>
                <strong>{eventLabel(event)}</strong>
                <small>{new Date(event.createdAt).toLocaleString()} · {activityStatusLabels[status]}{hostLabel} · 请求 {event.requestId}{diagnosticDetail(diagnostic)}</small>
              </div>
              {runId && <button className="button button-ghost button-small" type="button" onClick={() => onOpenRun?.(runId)}>{expired ? '结果已过期，需要重新执行' : '查看结果'}</button>}
            </li>
          );
        })}</ul>}
      {hasMore && <button className="button button-ghost button-small activity-load-more" type="button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更多活动'}</button>}
    </section>
  );
};
