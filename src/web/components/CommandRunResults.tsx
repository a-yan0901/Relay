import type { CommandRun } from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';

export interface CommandRunResultsProps {
  run: CommandRun;
  hosts: readonly HostMetadata[];
  onCancel?: () => void;
}

export const CommandRunResults = ({ run, hosts, onCancel }: CommandRunResultsProps) => {
  const names = new Map(hosts.map((host) => [host.id, host]));
  return (
    <section className="command-run-results" aria-label="批量执行结果">
      <div className="form-heading"><div><p className="eyebrow">RUN RESULTS</p><h2>执行结果 · {run.status}</h2></div></div>
      <code className="command-run-command">{run.command}</code>
      {onCancel && (run.status === 'queued' || run.status === 'running') && <button className="button button-ghost button-small" type="button" onClick={onCancel}>取消批量任务</button>}
      <ul>{run.targets.map((target) => { const host = names.get(target.hostId); return <li key={target.hostId} className={`command-target command-target-${target.status}`}><div><strong>{host?.name ?? target.hostId}</strong><small>{host?.address ?? '未知主机'} · {target.status}{target.exitCode === null ? '' : ` · exit ${target.exitCode}`}</small></div><pre>{target.output}{target.truncated ? '\n… 输出已截断' : ''}</pre></li>; })}</ul>
    </section>
  );
};
