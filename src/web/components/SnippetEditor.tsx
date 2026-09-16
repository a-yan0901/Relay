import { useState } from 'react';

import { AppError } from '@shared/errors';
import type { Snippet } from '../../shared/core/models';
import { extractCommandVariables, snippetSchema, type SnippetInput } from '../../shared/validation';

export interface SnippetEditorProps {
  snippet?: Snippet;
  onSubmit: (input: SnippetInput) => Promise<void> | void;
  onCancel: () => void;
}

export const SnippetEditor = ({ snippet, onSubmit, onCancel }: SnippetEditorProps) => {
  const [name, setName] = useState(snippet?.name ?? '');
  const [description, setDescription] = useState(snippet?.description ?? '');
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '');
  const [command, setCommand] = useState(snippet?.command ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const variableNames = (() => {
    try {
      return extractCommandVariables(command);
    } catch {
      return [];
    }
  })();

  const submit = async (): Promise<void> => {
    setError(null);
    let variables: string[];
    try {
      variables = extractCommandVariables(command);
    } catch {
      setError('命令中的变量格式无效，请使用 {{name}}。');
      return;
    }
    const parsed = snippetSchema.safeParse({
      name,
      description: description.trim() || null,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      command,
      variables
    });
    if (!parsed.success) {
      setError(new AppError('COMMAND_RUN_VALIDATION_FAILED').message);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } catch (submitError) {
      setError(submitError instanceof AppError ? submitError.message : '保存片段失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="snippet-editor" aria-labelledby="snippet-editor-title">
      <div className="form-heading"><div><p className="eyebrow">{snippet ? 'EDIT SNIPPET' : 'NEW SNIPPET'}</p><h3 id="snippet-editor-title">{snippet ? '编辑片段' : '新建片段'}</h3></div><button className="icon-button" type="button" aria-label="关闭片段编辑" title="关闭片段编辑" onClick={onCancel}>×</button></div>
      <div className="form-grid">
        <div className="field field-wide"><label htmlFor="snippet-name">片段名称</label><input id="snippet-name" aria-label="片段名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：检查服务状态" /></div>
        <div className="field field-wide"><label htmlFor="snippet-description">描述</label><input id="snippet-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></div>
        <div className="field field-wide"><label htmlFor="snippet-tags">标签</label><input id="snippet-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="ops, release" /></div>
        <div className="field field-wide"><label htmlFor="snippet-command">命令</label><textarea id="snippet-command" aria-label="命令" value={command} onChange={(event) => setCommand(event.target.value)} rows={6} spellCheck={false} placeholder="例如：systemctl status {{service}}" /></div>
      </div>
      <p className="snippet-variable-hint">{variableNames.length > 0 ? `执行时需要填写：${variableNames.map((name) => `{{${name}}}`).join('、')}` : '支持 {{name}} 格式的变量，执行前会再次确认。'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button button-ghost" type="button" onClick={onCancel}>取消</button><button className="button button-primary" type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? '保存中…' : '保存片段'}</button></div>
    </section>
  );
};
