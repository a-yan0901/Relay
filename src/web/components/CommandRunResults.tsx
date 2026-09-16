import { useEffect, useMemo, useState } from 'react';

import { diffCommandOutputs, filterCommandTargets, summarizeCommandTargets } from '../../shared/core/command-results';
import type { CommandRun, CommandTargetStatus } from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';

const commandStatusLabels: Record<CommandRun['status'], string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务重启中断'
};

const targetStatusLabels: Record<CommandTargetStatus, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

const targetSourceLabels: Record<NonNullable<NonNullable<CommandRun['targetSelection']>['source']>, string> = {
  servers: 'Server 列表',
  workspace: '当前工作区',
  group: '分组',
  tag: '标签',
  favorites: '收藏',
  recent: '最近连接'
};

const OUTPUT_PREVIEW_LIMIT = 12_000;

export interface CommandRunResultsProps {
  run: CommandRun;
  hosts: readonly HostMetadata[];
  onCancel?: () => void;
}

export const CommandRunResults = ({ run, hosts, onCancel }: CommandRunResultsProps) => {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CommandTargetStatus | 'all'>('all');
  const [errorFilter, setErrorFilter] = useState('');
  const [selectedHostIds, setSelectedHostIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedHostIds, setExpandedHostIds] = useState<ReadonlySet<string>>(new Set());
  const names = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const hostLabels = useMemo(() => new Map(hosts.map((host) => [host.id, `${host.name} ${host.address}`])), [hosts]);
  const summary = run.summary ?? summarizeCommandTargets(run.targets);
  const errorCodes = useMemo(() => [...new Set(run.targets.map((target) => target.errorCode).filter((code): code is string => code !== undefined))].sort(), [run.targets]);
  const filteredTargets = useMemo(() => filterCommandTargets(run.targets, {
    query,
    statuses: statusFilter === 'all' ? undefined : [statusFilter],
    errorCode: errorFilter,
    hostLabels
  }), [errorFilter, hostLabels, query, run.targets, statusFilter]);
  const selectedTargets = useMemo(() => run.targets.filter((target) => selectedHostIds.has(target.hostId)), [run.targets, selectedHostIds]);
  const outputDiffs = useMemo(() => diffCommandOutputs(selectedTargets), [selectedTargets]);

  useEffect(() => {
    setQuery('');
    setStatusFilter('all');
    setErrorFilter('');
    setSelectedHostIds(new Set());
    setExpandedHostIds(new Set());
  }, [run.id]);

  const toggleSetValue = (current: ReadonlySet<string>, value: string): ReadonlySet<string> => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <section className="command-run-results" aria-label="批量执行结果">
      <div className="form-heading"><div><p className="eyebrow">RUN RESULTS</p><h2>执行结果 · {commandStatusLabels[run.status]}</h2><p className="command-run-meta">请求 ID <code>{run.requestId ?? run.id}</code>{run.targetSelection && <> · 目标来源 {targetSourceLabels[run.targetSelection.source]} · {run.targetSelection.hostIds.length} 台</>}</p></div></div>
      <code className="command-run-command">{run.command}</code>
      {run.status === 'interrupted' && <p className="dialog-warning" role="status">服务重启后任务没有继续执行，已标记为中断；请确认影响后重新执行。</p>}
      <div className="command-result-summary" aria-label="执行汇总"><span>总计 {summary.total}</span><span>成功 {summary.completed}</span><span>失败 {summary.failed}</span><span>异常 {summary.anomalyCount}</span>{summary.truncatedCount > 0 && <span>输出截断 {summary.truncatedCount}</span>}</div>
      <div className="command-result-filters" aria-label="结果筛选"><label>搜索主机<input aria-label="搜索结果主机" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、地址或 Host ID" /></label><label>状态<select aria-label="筛选结果状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CommandTargetStatus | 'all')}><option value="all">全部状态</option>{(Object.keys(targetStatusLabels) as CommandTargetStatus[]).map((status) => <option value={status} key={status}>{targetStatusLabels[status]}</option>)}</select></label><label>错误码<select aria-label="筛选错误码" value={errorFilter} onChange={(event) => setErrorFilter(event.target.value)}><option value="">全部错误码</option>{errorCodes.map((code) => <option value={code} key={code}>{code}</option>)}</select></label></div>
      {selectedTargets.length >= 2 && <section className="command-output-diff" aria-label="输出 diff"><div className="command-output-diff-heading"><h3>输出 diff</h3><span>{selectedTargets.length} 台已选择</span></div>{outputDiffs.map((diff) => <article key={`${diff.referenceHostId}-${diff.targetHostId}`}><strong>{names.get(diff.targetHostId)?.name ?? diff.targetHostId} · 对比 {names.get(diff.referenceHostId)?.name ?? diff.referenceHostId}</strong>{diff.changed ? <pre>{diff.lines.map((line, index) => <span className={`command-diff-line command-diff-${line.kind}`} key={`${line.kind}-${index}`}>{`${line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}${line.text}\n`}</span>)}{diff.truncated ? '… diff 已截断\n' : ''}</pre> : <p>输出一致</p>}</article>)}</section>}
      {onCancel && (run.status === 'queued' || run.status === 'running') && <button className="button button-ghost button-small" type="button" onClick={onCancel}>取消批量任务</button>}
      {filteredTargets.length === 0 ? <p className="target-picker-empty">没有匹配的执行结果</p> : <ul>{filteredTargets.map((target) => {
        const host = names.get(target.hostId);
        const label = host?.name ?? target.hostId;
        const expanded = expandedHostIds.has(target.hostId);
        const outputIsLong = target.output.length > OUTPUT_PREVIEW_LIMIT;
        const displayOutput = expanded || !outputIsLong ? target.output : `${target.output.slice(0, OUTPUT_PREVIEW_LIMIT)}\n… 输出预览已截断，请展开查看`;
        return <li key={target.hostId} className={`command-target command-target-${target.status}`}><div className="command-target-heading"><label className="command-target-select"><input type="checkbox" aria-label={`选择对比 ${label}`} checked={selectedHostIds.has(target.hostId)} onChange={() => setSelectedHostIds((current) => toggleSetValue(current, target.hostId))} />对比</label><div><strong>{label}</strong><small>{host?.address ?? '未知主机'} · {targetStatusLabels[target.status]}{target.errorCode === 'SERVICE_RESTARTED' ? ' · 服务已重启' : ''}{target.exitCode === null ? '' : ` · exit ${target.exitCode}`}</small></div></div><div className="command-target-actions"><span>{target.outputBytes.toLocaleString()} bytes{target.truncated ? ' · 服务端已截断' : ''}</span><button className="button button-ghost button-small" type="button" aria-label={`${expanded ? '收起输出' : '查看输出'} ${label}`} aria-expanded={expanded} onClick={() => setExpandedHostIds((current) => toggleSetValue(current, target.hostId))}>{expanded ? '收起输出' : '查看输出'}</button></div>{expanded && <pre>{displayOutput || '（无输出）'}</pre>}</li>;
      })}</ul>}
    </section>
  );
};
