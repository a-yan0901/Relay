import type { TransferJob } from '../../shared/core/models';

export interface TransferQueueProps {
  jobs: readonly TransferJob[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export const TransferQueue = ({ jobs, onCancel, onRetry }: TransferQueueProps) => (
  <section className="transfer-queue" aria-label="文件传输队列">
    <div className="form-heading"><div><p className="eyebrow">TRANSFERS</p><h2>传输队列</h2></div></div>
    {jobs.length === 0 ? <p className="sftp-empty-state">暂无文件传输</p> : <ul>{jobs.map((job) => { const percentage = job.totalBytes && job.totalBytes > 0 ? Math.min(100, Math.round(job.completedBytes / job.totalBytes * 100)) : null; return <li key={job.id} className="transfer-item"><div><strong>{job.kind === 'upload' ? '上传' : '下载'} · {job.targetPath}</strong><small>{job.status}{percentage === null ? '' : ` · ${percentage}%`}</small></div>{['queued', 'running'].includes(job.status) && onCancel && <button className="button button-ghost button-small" type="button" onClick={() => onCancel(job.id)}>取消</button>}{job.status === 'failed' && onRetry && <button className="button button-ghost button-small" type="button" onClick={() => onRetry(job.id)}>重试</button>}</li>; })}</ul>}
  </section>
);
