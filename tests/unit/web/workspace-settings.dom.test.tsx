// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImportPreview } from '../../../src/shared/import/types.js';
import { WorkspaceSettings } from '../../../src/web/components/WorkspaceSettings';

const preview: ImportPreview = {
  previewId: 'preview-1',
  source: { filename: 'connections.csv', format: 'ssh-csv' },
  sources: [{ filename: 'connections.csv', format: 'ssh-csv' }],
  connectionCount: 1,
  groupCount: 1,
  connections: [{
    sourceId: 'csv:1', name: 'app', address: 'app.example.com', port: 22, username: 'deploy', authType: 'password',
    credentialState: 'needs-user-input', groupPath: ['Production'], tags: [], jumpHostSourceIds: [], notes: [], sourceFields: {}, applicable: false, conflicts: []
  }],
  conflicts: [],
  warnings: [],
  expiresAt: '2026-09-15T00:10:00.000Z'
};

describe('WorkspaceSettings import/export flows', () => {
  afterEach(() => cleanup());

  it('previews an external file, supports credential补录, and does not render source secrets', async () => {
    const user = userEvent.setup();
    const onPreviewExternalImport = vi.fn(async () => preview);
    const onApplyExternalImport = vi.fn(async () => ({ importedHosts: 1, skippedHosts: 0, importedGroups: 1, skippedGroups: 0, warnings: [] }));
    render(<WorkspaceSettings
      mode="import"
      onClose={vi.fn()}
      onExport={vi.fn(async () => '{}')}
      onPreviewImport={vi.fn(async () => ({ previewId: 'vault', hostCount: 0, groupCount: 0, conflicts: [], expiresAt: '' }))}
      onApplyImport={vi.fn(async () => ({ importedHosts: 0, importedGroups: 0, skippedHosts: 0, skippedGroups: 0 }))}
      onPreviewExternalImport={onPreviewExternalImport}
      onApplyExternalImport={onApplyExternalImport}
    />);

    const source = new File(['name,host,user,password\napp,app.example.com,deploy,source-secret'], 'connections.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('导入文件'), source);
    await user.click(screen.getByRole('button', { name: '预览导入' }));

    expect(onPreviewExternalImport).toHaveBeenCalledWith([{
      filename: 'connections.csv',
      content: 'name,host,user,password\napp,app.example.com,deploy,source-secret'
    }]);
    expect(screen.getByText('需要补录凭据')).toBeInTheDocument();
    expect(screen.queryByText('source-secret')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('为 app 补录密码'), 'filled-secret');
    await user.click(screen.getByRole('button', { name: '确认导入' }));
    expect(onApplyExternalImport).toHaveBeenCalledWith('preview-1', expect.objectContaining({
      selectedSourceIds: ['csv:1'],
      credentials: [{ sourceId: 'csv:1', credential: { type: 'password', password: 'filled-secret' } }]
    }));
  });

  it('allows importing an external record without a password for later connection', async () => {
    const user = userEvent.setup();
    const onPreviewExternalImport = vi.fn(async () => preview);
    const onApplyExternalImport = vi.fn(async () => ({ importedHosts: 1, skippedHosts: 0, importedGroups: 0, skippedGroups: 0, warnings: [] }));
    render(<WorkspaceSettings
      mode="import"
      onClose={vi.fn()}
      onExport={vi.fn(async () => '{}')}
      onPreviewImport={vi.fn(async () => ({ previewId: 'vault', hostCount: 0, groupCount: 0, conflicts: [], expiresAt: '' }))}
      onApplyImport={vi.fn(async () => ({ importedHosts: 0, importedGroups: 0, skippedHosts: 0, skippedGroups: 0 }))}
      onPreviewExternalImport={onPreviewExternalImport}
      onApplyExternalImport={onApplyExternalImport}
    />);

    await user.upload(screen.getByLabelText('导入文件'), new File(['name,host,user,password\napp,app.example.com,deploy,'], 'connections.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '预览导入' }));
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    expect(onApplyExternalImport).toHaveBeenCalledWith('preview-1', expect.objectContaining({
      selectedSourceIds: ['csv:1'],
      credentials: []
    }));
  });

  it('recognizes an encrypted Vault bundle and routes preview through the Vault flow', async () => {
    const user = userEvent.setup();
    const onPreviewImport = vi.fn(async () => ({ previewId: 'vault-preview', hostCount: 2, groupCount: 1, conflicts: [], expiresAt: '' }));
    const onPreviewExternalImport = vi.fn(async () => preview);
    const bundle = '{"format":"webssh-vault","version":1}';
    render(<WorkspaceSettings
      mode="import"
      onClose={vi.fn()}
      onExport={vi.fn(async () => '{}')}
      onPreviewImport={onPreviewImport}
      onApplyImport={vi.fn(async () => ({ importedHosts: 2, importedGroups: 1, skippedHosts: 0, skippedGroups: 0 }))}
      onPreviewExternalImport={onPreviewExternalImport}
      onApplyExternalImport={vi.fn(async () => ({ importedHosts: 0, skippedHosts: 0, importedGroups: 0, skippedGroups: 0, warnings: [] }))}
    />);

    await user.upload(screen.getByLabelText('导入文件'), new File([bundle], 'relay-vault.json', { type: 'application/json' }));
    expect(screen.getByText('识别为 Vault 数据包')).toBeInTheDocument();
    await user.type(screen.getByLabelText('导出密码'), 'bundle-password');
    await user.click(screen.getByRole('button', { name: '预览导入' }));

    expect(onPreviewImport).toHaveBeenCalledWith('bundle-password', bundle);
    expect(onPreviewExternalImport).not.toHaveBeenCalled();
  });

  it('exports the encrypted Vault bundle with only an export password', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn(async () => '{}');
    const createObjectUrl = vi.fn(() => 'blob:fixture');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    render(<WorkspaceSettings
      mode="export"
      onClose={vi.fn()}
      onExport={onExport}
      onPreviewImport={vi.fn(async () => ({ previewId: 'vault', hostCount: 0, groupCount: 0, conflicts: [], expiresAt: '' }))}
      onApplyImport={vi.fn(async () => ({ importedHosts: 0, importedGroups: 0, skippedHosts: 0, skippedGroups: 0 }))}
      onPreviewExternalImport={vi.fn(async () => preview)}
      onApplyExternalImport={vi.fn(async () => ({ importedHosts: 0, skippedHosts: 0, importedGroups: 0, skippedGroups: 0, warnings: [] }))}
    />);

    await user.type(screen.getByLabelText('导出密码'), 'bundle-password');
    await user.click(screen.getByRole('button', { name: '导出' }));

    expect(onExport).toHaveBeenCalledWith('bundle-password');
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fixture');
  });
});
