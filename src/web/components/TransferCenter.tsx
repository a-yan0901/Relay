import type { TransferJob } from '../../shared/core/models';
import { operationNextAction } from '../../shared/core/state-machines';

export interface TransferCenterProps {
  jobs: readonly TransferJob[];
  hostAliases?: Readonly<Record<string, string>>;
  onCancel?: (id: string) => void;
  onPause?: (id: string) => void;
  onRetry?: (id: string) => void;
  onResume?: (id: string) => void;
  /** Whether paused/interrupted jobs can safely continue from a checkpoint. */
  resumeSupported?: boolean;
  onOpenPath?: (job: TransferJob) => void;
  ariaLabel?: string;
  includeJobIdInActionLabel?: boolean;
}

const transferStatusLabels: Record<TransferJob['status'], string> = {
  queued: '排队中',
  running: '传输中',
  paused: '已暂停，可继续',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务重启中断，可重试'
};

const transferStatusLabel = (job: TransferJob, resumeSupported: boolean): string => (
  job.status === 'paused' && !resumeSupported ? '已暂停，可重试' : transferStatusLabels[job.status]
);

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

const errorDetail = (job: TransferJob): string => {
  if (!job.errorCode) return '';
  return `${job.errorCode} · ${transferErrorLabels[job.errorCode] ?? '请检查传输状态'}`;
};

const recoveryDetail = (job: TransferJob, resumeSupported: boolean): string => {
  if (!resumeSupported) return '';
  const offset = job.checkpoint?.offset ?? job.completedBytes;
  if (job.status === 'paused') return offset > 0 ? `可从 ${formatBytes(offset)} 继续` : '';
  if (!['failed', 'interrupted'].includes(job.status) || offset <= 0) return '';
  const retryable = operationNextAction('failed', !['SFTP_PERMISSION_DENIED', 'SFTP_PATH_INVALID'].includes(job.errorCode ?? ''), job.errorCode) === 'retry';
  return retryable ? `可从 ${formatBytes(offset)} 继续` : `已保留 ${formatBytes(offset)} 检查点`;
};

const remotePathForJob = (job: TransferJob): string => job.kind === 'upload' ? job.targetPath : job.sourcePath;

export const TransferCenter = ({
  jobs,
  hostAliases = {},
  onCancel,
  onPause,
  onRetry,
  onResume,
  resumeSupported = true,
  onOpenPath,
  ariaLabel = '传输中心',
  includeJobIdInActionLabel = true
}: TransferCenterProps) => {
  const activeCount = jobs.filter((job) => ['queued', 'running'].includes(job.status)).length;
  const pausedCount = jobs.filter((job) => job.status === 'paused').length;
  const issueCount = jobs.filter((job) => ['failed', 'interrupted'].includes(job.status)).length;

  return (
    <section className="transfer-center transfer-queue" aria-label={ariaLabel}>
      <div className="form-heading">
        <div><p className="eyebrow">TRANSFER CENTER</p><h2>传输中心</h2></div>
        {jobs.length > 0 && <div className="transfer-center-summary" role="status" aria-live="polite"><span>{activeCount} 个进行中</span>{pausedCount > 0 && <span>{pausedCount} 个已暂停</span>}<span className={issueCount > 0 ? 'has-issues' : ''}>{issueCount} 个需要处理</span></div>}
      </div>
      {jobs.length === 0
        ? <p className="sftp-empty-state">暂无文件传输</p>
        : <ul>{jobs.map((job) => {
          const percentage = job.totalBytes && job.totalBytes > 0
            ? Math.min(100, Math.round(job.completedBytes / job.totalBytes * 100))
            : null;
          const checkpointOffset = job.checkpoint?.offset ?? job.completedBytes;
          const error = errorDetail(job);
          const recovery = recoveryDetail(job, resumeSupported);
          const remotePath = remotePathForJob(job);
          const alias = hostAliases[job.hostId] ?? job.hostId;
          const canResume = resumeSupported && ['paused', 'interrupted'].includes(job.status) && onResume !== undefined;
          return (
            <li key={job.id} className={`transfer-item transfer-item-${job.status}`} data-transfer-id={job.id}>
              <div className="transfer-item-content">
                <div className="transfer-item-title"><strong>{job.kind === 'upload' ? '上传' : '下载'} · <span className="transfer-host-alias">{alias}</span></strong>{onOpenPath ? <button className="transfer-path-button" type="button" onClick={() => onOpenPath(job)} aria-label={`回到路径 ${job.id}`}>{remotePath}</button> : <span className="transfer-path-button">{remotePath}</span>}</div>
                <small>{transferStatusLabel(job, resumeSupported)}{percentage === null ? '' : ` · ${percentage}%`}{job.status === 'running' && job.speedBytesPerSecond !== undefined ? ` · ${formatRate(job.speedBytesPerSecond)}` : ''}{job.status === 'running' && job.etaSeconds !== undefined && job.etaSeconds !== null ? ` · 预计 ${formatEta(job.etaSeconds)}` : ''}</small>
                {percentage !== null && <progress value={percentage} max={100} aria-label={`${job.id} 传输进度`} />}
                <span className="transfer-item-context">远端路径：{remotePath} · 断点 {formatBytes(checkpointOffset)}{error ? ` · 错误码：${error}` : ''}{recovery ? ` · ${recovery}` : ''}</span>
              </div>
              <div className="transfer-item-actions">
                {['queued', 'running'].includes(job.status) && onPause && <button className="button button-ghost button-small" type="button" onClick={() => onPause(job.id)} aria-label={includeJobIdInActionLabel ? `暂停 ${job.id}` : '暂停'}>暂停</button>}
                {['queued', 'running'].includes(job.status) && onCancel && <button className="button button-ghost button-small" type="button" onClick={() => onCancel(job.id)} aria-label={includeJobIdInActionLabel ? `取消 ${job.id}` : '取消'}>取消</button>}
                {['paused', 'interrupted'].includes(job.status) && onResume && <button className="button button-ghost button-small" type="button" onClick={() => onResume(job.id)} aria-label={includeJobIdInActionLabel ? `继续 ${job.id}` : '重试'}>继续</button>}
                {['paused', 'interrupted'].includes(job.status) && !onResume && onRetry && <button className="button button-ghost button-small" type="button" onClick={() => onRetry(job.id)} aria-label={includeJobIdInActionLabel ? `重试 ${job.id}` : '重试'}>重试</button>}
                {job.status === 'failed' && onRetry && <button className="button button-ghost button-small" type="button" onClick={() => onRetry(job.id)} aria-label={includeJobIdInActionLabel ? `重试 ${job.id}` : '重试'}>重试</button>}
                {canResume && <span className="visually-hidden">可从断点继续</span>}
              </div>
            </li>
          );
        })}</ul>}
    </section>
  );
};
