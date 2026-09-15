import type { AuditEvent } from '../../shared/core/models';

export interface ActivityPanelProps {
  events: readonly AuditEvent[];
  expiredRunIds?: ReadonlySet<string>;
  onOpenRun?: (runId: string) => void;
}

const eventLabel = (event: AuditEvent): string => {
  if (event.eventType === 'command_run_summary') {
    const targetCount = event.metadata.targetCount ?? 0;
    const successCount = event.metadata.successCount ?? 0;
    const failureCount = event.metadata.failureCount ?? 0;
    return `批量任务 · ${targetCount} 台主机 · ${successCount} 成功 / ${failureCount} 失败`;
  }
  if (event.eventType.startsWith('connection_')) return event.eventType === 'connection_succeeded' ? '连接成功' : '连接失败';
  if (event.eventType.startsWith('sftp_')) return event.eventType.replaceAll('_', ' ');
  return event.eventType.replaceAll('_', ' ');
};

export const ActivityPanel = ({ events, expiredRunIds = new Set<string>(), onOpenRun }: ActivityPanelProps) => (
  <section className="activity-panel" aria-label="最近活动">
    <div className="form-heading"><div><p className="eyebrow">ACTIVITY</p><h2>最近活动</h2></div></div>
    {events.length === 0 ? <p className="sftp-empty-state">暂无活动</p> : <ul>{events.map((event) => { const runId = typeof event.metadata.runId === 'string' ? event.metadata.runId : undefined; const expired = runId !== undefined && expiredRunIds.has(runId); return <li key={event.id} className="activity-item"><div><strong>{eventLabel(event)}</strong><small>{new Date(event.createdAt).toLocaleString()}</small></div>{runId && <button className="button button-ghost button-small" type="button" onClick={() => onOpenRun?.(runId)}>{expired ? '结果已过期，需要重新执行' : '查看结果'}</button>}</li>; })}</ul>}
  </section>
);
