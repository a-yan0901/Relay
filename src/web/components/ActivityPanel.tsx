import type { AuditEvent, OperationDiagnostic } from '../../shared/core/models';
import { operationStageLabels, operationNextActionLabels } from './ConnectionStatus';

export interface ActivityPanelProps {
  events: readonly AuditEvent[];
  expiredRunIds?: ReadonlySet<string>;
  onOpenRun?: (runId: string) => void;
  diagnostics?: readonly OperationDiagnostic[];
}

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

export const ActivityPanel = ({ events, expiredRunIds = new Set<string>(), onOpenRun, diagnostics = [] }: ActivityPanelProps) => {
  const diagnosticByOperationId = new Map(diagnostics.map((diagnostic) => [diagnostic.operationId, diagnostic]));
  return (
    <section className="activity-panel" aria-label="最近活动">
      <div className="form-heading"><div><p className="eyebrow">ACTIVITY</p><h2>最近活动</h2></div></div>
      {events.length === 0
        ? <p className="sftp-empty-state">暂无活动</p>
        : <ul>{events.map((event) => {
          const runId = typeof event.metadata.runId === 'string' ? event.metadata.runId : undefined;
          const expired = runId !== undefined && expiredRunIds.has(runId);
          const diagnostic = runId ? diagnosticByOperationId.get(runId) : undefined;
          return (
            <li key={event.id} className="activity-item">
              <div>
                <strong>{eventLabel(event)}</strong>
                <small>{new Date(event.createdAt).toLocaleString()} · 请求 {event.requestId}{diagnosticDetail(diagnostic)}</small>
              </div>
              {runId && <button className="button button-ghost button-small" type="button" onClick={() => onOpenRun?.(runId)}>{expired ? '结果已过期，需要重新执行' : '查看结果'}</button>}
            </li>
          );
        })}</ul>}
    </section>
  );
};
