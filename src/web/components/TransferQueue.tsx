import type { TransferJob } from '../../shared/core/models';

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

export const TransferQueue = ({ jobs, onCancel, onRetry }: TransferQueueProps) => (
  <section className="transfer-queue" aria-label="文件传输队列">
    <div className="form-heading"><div><p className="eyebrow">TRANSFERS</p><h2>传输队列</h2></div></div>
    {jobs.length === 0 ? <p className="sftp-empty-state">暂无文件传输</p> : <ul>{jobs.map((job) => { const percentage = job.totalBytes && job.totalBytes > 0 ? Math.min(100, Math.round(job.completedBytes / job.totalBytes * 100)) : null; return <li key={job.id} className="transfer-item"><div><strong>{job.kind === 'upload' ? '上传' : '下载'} · {job.targetPath}</strong><small>{transferStatusLabels[job.status]}{percentage === null ? '' : ` · ${percentage}%`}</small></div>{['queued', 'running'].includes(job.status) && onCancel && <button className="button button-ghost button-small" type="button" onClick={() => onCancel(job.id)}>取消</button>}{['failed', 'interrupted'].includes(job.status) && onRetry && <button className="button button-ghost button-small" type="button" onClick={() => onRetry(job.id)}>重试</button>}</li>; })}</ul>}
  </section>
);
