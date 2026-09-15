import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import type { SftpEntry } from '../../shared/core/models';

export interface SftpPanelProps {
  hostId: string;
  onList: (hostId: string, path: string) => Promise<readonly SftpEntry[]>;
  onDelete?: (path: string) => Promise<void>;
  onUpload?: (file: File, path: string) => Promise<void>;
  onDownload?: (path: string, name: string) => Promise<void>;
  onNavigate?: (path: string) => void;
}

export const SftpPanel = ({ hostId, onList, onDelete, onUpload, onDownload, onNavigate }: SftpPanelProps) => {
  const [path, setPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [entries, setEntries] = useState<readonly SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await onList(hostId, path);
      if (sequence === loadSequence.current) setEntries(nextEntries);
    } catch {
      if (sequence === loadSequence.current) {
        setEntries([]);
        setError('无法读取远程目录');
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [hostId, onList, path]);

  useEffect(() => { void load(); }, [load]);

  const navigate = (entry: SftpEntry): void => {
    if (entry.type !== 'directory') return;
    setPath(entry.path);
    setPathInput(entry.path);
    onNavigate?.(entry.path);
  };

  const navigateToPath = (): void => setPath(pathInput.trim() || '/');

  const confirmDelete = async (): Promise<void> => {
    if (!deletePath || !onDelete) return;
    try {
      await onDelete(deletePath);
      setDeletePath(null);
      await load();
    } catch {
      setError('删除失败，请检查远程权限');
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onUpload) return;
    setUploading(true);
    setError(null);
    try {
      await onUpload(file, path);
      await load();
    } catch {
      setError('上传失败，请检查远程权限');
    } finally {
      setUploading(false);
    }
  };

  const download = async (entry: SftpEntry): Promise<void> => {
    if (!onDownload) return;
    setError(null);
    try {
      await onDownload(entry.path, entry.name);
    } catch {
      setError('下载失败，请检查远程权限');
    }
  };

  return (
    <section className="sftp-panel" aria-label="远程文件">
      <div className="sftp-panel-heading"><div><p className="eyebrow">REMOTE FILES</p><h2>SFTP</h2></div><div className="sftp-panel-actions"><label className="sftp-path-input"><span className="visually-hidden">远程路径</span><input aria-label="远程路径" value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') navigateToPath(); }} /></label><button className="button button-ghost button-small" type="button" onClick={navigateToPath}>跳转</button><button className="button button-ghost button-small" type="button" onClick={() => void load()}>刷新</button>{onUpload && <label className="button button-ghost button-small sftp-upload-button">{uploading ? '上传中…' : '上传'}<input type="file" aria-label="选择上传文件" onChange={(event) => void upload(event)} disabled={uploading} /></label>}</div></div>
      {loading && <p className="sftp-empty-state">正在读取目录…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && entries.length === 0 && <p className="sftp-empty-state">目录为空</p>}
      {!loading && !error && entries.length > 0 && <ul className="sftp-entry-list">{entries.map((entry) => <li key={entry.path} className="sftp-entry"><button type="button" className="sftp-entry-name" onClick={() => navigate(entry)} disabled={entry.type !== 'directory'}><span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span>{entry.name}</button><span className="sftp-entry-meta">{entry.type === 'directory' ? '目录' : `${entry.size} B`}</span>{entry.type === 'file' && onDownload && <button type="button" className="icon-button" aria-label={`下载 ${entry.name}`} onClick={() => void download(entry)}>↓</button>}{onDelete && <button type="button" className="icon-button" aria-label={`删除 ${entry.name}`} onClick={() => setDeletePath(entry.path)}>×</button>}</li>)}</ul>}
      {deletePath && <div className="modal-backdrop" role="presentation"><section className="host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="sftp-delete-title"><p className="eyebrow">CONFIRM DELETE</p><h2 id="sftp-delete-title">删除远程文件？</h2><p className="dialog-copy">{deletePath}</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDeletePath(null)}>取消</button><button className="button button-primary" type="button" onClick={() => void confirmDelete()}>确认删除</button></div></section></div>}
    </section>
  );
};
