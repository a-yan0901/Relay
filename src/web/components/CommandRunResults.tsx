import type { CommandRun } from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';

const commandStatusLabels: Record<CommandRun['status'], string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务重启中断'
};

export interface CommandRunResultsProps {
  run: CommandRun;
  hosts: readonly HostMetadata[];
  onCancel?: () => void;
}

export const CommandRunResults = ({ run, hosts, onCancel }: CommandRunResultsProps) => {
  const names = new Map(hosts.map((host) => [host.id, host]));
  return (
    <section className="command-run-results" aria-label="批量执行结果">
      <div className="form-heading"><div><p className="eyebrow">RUN RESULTS</p><h2>执行结果 · {commandStatusLabels[run.status]}</h2></div></div>
      <code className="command-run-command">{run.command}</code>
      {run.targets.some((target) => target.errorCode === 'SERVER_RESTARTED') && <p className="dialog-warning" role="status">服务重启后任务没有继续执行，已保留为失败结果。</p>}
      {onCancel && (run.status === 'queued' || run.status === 'running') && <button className="button button-ghost button-small" type="button" onClick={onCancel}>取消批量任务</button>}
      <ul>{run.targets.map((target) => { const host = names.get(target.hostId); return <li key={target.hostId} className={`command-target command-target-${target.status}`}><div><strong>{host?.name ?? target.hostId}</strong><small>{host?.address ?? '未知主机'} · {target.status}{target.errorCode === 'SERVER_RESTARTED' ? ' · 服务已重启' : ''}{target.exitCode === null ? '' : ` · exit ${target.exitCode}`}</small></div><pre>{target.output}{target.truncated ? '\n… 输出已截断' : ''}</pre></li>; })}</ul>
    </section>
  );
};
