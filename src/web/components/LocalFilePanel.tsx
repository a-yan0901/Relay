import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';

export interface LocalFilePanelProps {
  remotePath: string;
  onFilesSelected: (files: readonly File[]) => void | Promise<void>;
  onPickUpload?: () => void | Promise<void>;
  disabled?: boolean;
}

const filesFromList = (files: FileList | null): File[] => files ? Array.from(files) : [];

export const LocalFilePanel = ({ remotePath, onFilesSelected, onPickUpload, disabled = false }: LocalFilePanelProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const submit = (files: readonly File[]): void => {
    if (disabled || files.length === 0) return;
    void onFilesSelected(files);
  };

  const selectFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    submit(filesFromList(event.target.files));
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    submit(filesFromList(event.dataTransfer.files));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (onPickUpload) void onPickUpload();
    else inputRef.current?.click();
  };

  const pick = (): void => {
    if (disabled) return;
    if (onPickUpload) void onPickUpload();
    else inputRef.current?.click();
  };

  return (
    <section className="local-file-panel" aria-label="本地文件">
      <div className="form-heading">
        <div><p className="eyebrow">LOCAL FILES</p><h2>本地文件</h2></div>
        <span className="local-file-panel-count">多选</span>
      </div>
      <p className="local-file-panel-path">目标目录：{remotePath}</p>
      <div
        className={`local-file-dropzone ${dragging ? 'is-dragging' : ''}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`拖放文件到 ${remotePath}`}
        aria-disabled={disabled}
        data-drop-path={remotePath}
        onClick={pick}
        onKeyDown={onKeyDown}
        onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={onDrop}
      >
        <span className="local-file-dropzone-icon" aria-hidden="true">＋</span>
        <strong>{disabled ? '当前不可上传' : '拖放文件到此处'}</strong>
        <small>或点击选择本地文件</small>
        {!onPickUpload && <input ref={inputRef} type="file" multiple aria-label="选择本地文件" onChange={selectFiles} disabled={disabled} />}
      </div>
      <p className="local-file-panel-hint">文件会进入传输中心，远端只在传输完成后显示最终文件。</p>
    </section>
  );
};
