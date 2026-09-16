import type { TransferJob } from '../../shared/core/models';
import { operationNextAction } from '../../shared/core/state-machines';

export interface TransferQueueProps {
  jobs: readonly TransferJob[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

const transferStatusLabels: Record<TransferJob['status'], string> = {
  queued: '排队中',
  running: '传输中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务重启中断，可重试'
};

const transferErrorLabels: Record<string, string> = {
  SFTP_PERMISSION_DENIED: '远程权限不足',
  SFTP_PATH_INVALID: '远程路径无效',
  SFTP_CONNECTION_FAILED: 'SFTP 连接异常',
  TRANSFER_RESUME_INVALID: '断点校验失败，将从安全位置重新开始',
  SERVICE_RESTARTED: '服务已重启'
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const formatRate = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`;

const formatEta = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ''}`;
};

const transferDetail = (job: TransferJob): string => {
  const error = job.errorCode ? transferErrorLabels[job.errorCode] ?? job.errorCode : undefined;
  const checkpointOffset = job.checkpoint?.offset ?? job.completedBytes;
  const recovery = ['failed', 'interrupted'].includes(job.status) && checkpointOffset > 0
    ? `可从 ${formatBytes(checkpointOffset)} 继续`
    : undefined;
  if (job.status === 'interrupted') return [error, recovery].filter(Boolean).join(' · ');
  if (job.status === 'running' || job.status === 'completed' || job.status === 'cancelled' || job.status === 'queued') return error ?? '';
  const action = operationNextAction('failed', !['SFTP_PERMISSION_DENIED', 'SFTP_PATH_INVALID'].includes(job.errorCode ?? ''), job.errorCode);
  const actionLabel = action === 'retry' ? '可重试' : action === 'none' ? '' : '请处理';
  return [error, recovery, actionLabel].filter(Boolean).join(' · ');
};

export const TransferQueue = ({ jobs, onCancel, onRetry }: TransferQueueProps) => (
  <section className="transfer-queue" aria-label="文件传输队列">
    <div className="form-heading"><div><p className="eyebrow">TRANSFERS</p><h2>传输队列</h2></div></div>
    {jobs.length === 0
      ? <p className="sftp-empty-state">暂无文件传输</p>
      : <ul>{jobs.map((job) => {
        const percentage = job.totalBytes && job.totalBytes > 0
          ? Math.min(100, Math.round(job.completedBytes / job.totalBytes * 100))
          : null;
        const detail = transferDetail(job);
        const throughput = job.status === 'running' && job.speedBytesPerSecond !== undefined
          ? ` · ${formatRate(job.speedBytesPerSecond)}`
          : '';
        const eta = job.status === 'running' && job.etaSeconds !== undefined && job.etaSeconds !== null
          ? ` · 预计 ${formatEta(job.etaSeconds)}`
          : '';
        return (
          <li key={job.id} className="transfer-item">
            <div>
              <strong>{job.kind === 'upload' ? '上传' : '下载'} · {job.targetPath}</strong>
              <small>{transferStatusLabels[job.status]}{percentage === null ? '' : ` · ${percentage}%`}{throughput}{eta}{detail ? ` · ${detail}` : ''}</small>
            </div>
            {['queued', 'running'].includes(job.status) && onCancel && <button className="button button-ghost button-small" type="button" onClick={() => onCancel(job.id)}>取消</button>}
            {['failed', 'interrupted'].includes(job.status) && onRetry && <button className="button button-ghost button-small" type="button" onClick={() => onRetry(job.id)}>重试</button>}
          </li>
        );
      })}</ul>}
  </section>
);
