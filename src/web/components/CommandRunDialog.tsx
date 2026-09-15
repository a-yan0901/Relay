import { useMemo, useState } from 'react';

import type { CommandRunRequest } from '../../shared/core/models';
import { assessCommandRisk } from '../../shared/core/command-safety';
import type { Snippet, SnippetMetadata } from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';
import { expandCommandTemplate, extractCommandVariables } from '../../shared/validation';
import { SnippetPicker } from './SnippetPicker';

export interface CommandRunDialogProps {
  hosts: readonly HostMetadata[];
  hostIds: readonly string[];
  initialCommand?: string;
  initialVariables?: Readonly<Record<string, string>>;
  snippets?: readonly SnippetMetadata[];
  onSnippetSelect?: (id: string) => Promise<Snippet | void> | Snippet | void;
  onConfirm: (request: CommandRunRequest) => Promise<void> | void;
  onClose: () => void;
}

const formatSeconds = (milliseconds: number): number => Math.round(milliseconds / 1000);

export const CommandRunDialog = ({
  hosts,
  hostIds,
  initialCommand = '',
  initialVariables = {},
  snippets = [],
  onSnippetSelect,
  onConfirm,
  onClose
}: CommandRunDialogProps) => {
  const [command, setCommand] = useState(initialCommand);
  const [variables, setVariables] = useState<Record<string, string>>({ ...initialVariables });
  const [concurrency, setConcurrency] = useState(4);
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [persistOutput, setPersistOutput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const uniqueHostIds = useMemo(() => [...new Set(hostIds)], [hostIds]);
  const variableNames = useMemo(() => {
    try { return extractCommandVariables(command); } catch { return []; }
  }, [command]);
  const expanded = useMemo(() => {
    try { return expandCommandTemplate(command, variables); } catch { return null; }
  }, [command, variables]);
  const risk = assessCommandRisk(expanded ?? command);
  const selectedHosts = uniqueHostIds.map((id) => hosts.find((host) => host.id === id)).filter((host): host is HostMetadata => host !== undefined);
  const canSubmit = expanded !== null && expanded.trim().length > 0 && selectedHosts.length === uniqueHostIds.length && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit || expanded === null) return;
    setSubmitting(true);
    try {
      await onConfirm({ command: expanded, hostIds: uniqueHostIds, variables: {}, concurrency, timeoutMs, persistOutput, confirmed: true });
    } finally {
      setSubmitting(false);
    }
  };

  const selectSnippet = async (id: string): Promise<void> => {
    const snippet = await onSnippetSelect?.(id);
    if (!snippet) return;
    setCommand(snippet.command);
    setVariables(Object.fromEntries(snippet.variables.map((name) => [name, variables[name] ?? ''])));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="command-run-dialog" role="dialog" aria-modal="true" aria-labelledby="command-run-title">
        <div className="form-heading">
          <div><p className="eyebrow">SAFE BATCH EXECUTION</p><h2 id="command-run-title">批量执行</h2></div>
          <button className="icon-button" type="button" aria-label="关闭批量执行" onClick={onClose}>×</button>
        </div>
        <label className="command-field" htmlFor="command-run-input"><span>命令</span><textarea id="command-run-input" value={command} onChange={(event) => setCommand(event.target.value)} rows={3} /></label>
        {snippets.length > 0 && <SnippetPicker snippets={snippets} onSelect={(id) => void selectSnippet(id)} />}
        {variableNames.length > 0 && <div className="command-variable-fields"><p>参数</p>{variableNames.map((name) => <label key={name} htmlFor={`command-variable-${name}`}><span>{`{{${name}}}`}</span><input id={`command-variable-${name}`} value={variables[name] ?? ''} onChange={(event) => setVariables((current) => ({ ...current, [name]: event.target.value }))} /></label>)}</div>}
        <div className="command-run-preview" aria-label="执行预览">
          <div><strong>目标主机</strong><ul>{selectedHosts.map((host) => <li key={host.id}>{host.name} · {host.address}</li>)}</ul></div>
          <div><strong>展开命令</strong><code>{expanded ?? '请补全所有参数'}</code></div>
          <div className="command-run-settings"><span>并发 {concurrency}</span><span>超时 {formatSeconds(timeoutMs)} 秒</span><label><input type="checkbox" checked={persistOutput} onChange={(event) => setPersistOutput(event.target.checked)} /> 保存输出</label></div>
          {risk.requiresConfirmation && <p className="form-warning" role="alert">高风险命令：{risk.reasons.join('、')}。请确认影响范围。</p>}
        </div>
        <div className="command-run-controls"><label htmlFor="command-concurrency">并发<select id="command-concurrency" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 4, 8, 16].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label htmlFor="command-timeout">超时<select id="command-timeout" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))}>{[30_000, 60_000, 300_000, 600_000].map((value) => <option key={value} value={value}>{formatSeconds(value)} 秒</option>)}</select></label></div>
        <div className="dialog-actions"><button className="button button-ghost" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="button" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? '执行中…' : '确认执行'}</button></div>
      </section>
    </div>
  );
};
