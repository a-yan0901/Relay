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

describe('WorkspaceSettings external migration', () => {
  afterEach(() => cleanup());

  it('previews an external file, supports credential补录, and does not render source secrets', async () => {
    const user = userEvent.setup();
    const onPreviewExternalImport = vi.fn(async () => preview);
    const onApplyExternalImport = vi.fn(async () => ({ importedHosts: 1, skippedHosts: 0, importedGroups: 1, skippedGroups: 0, warnings: [] }));
    render(<WorkspaceSettings
      onClose={vi.fn()}
      onExport={vi.fn(async () => '{}')}
      onPreviewImport={vi.fn(async () => ({ previewId: 'vault', hostCount: 0, groupCount: 0, conflicts: [], expiresAt: '' }))}
      onApplyImport={vi.fn(async () => ({ importedHosts: 0, importedGroups: 0, skippedHosts: 0, skippedGroups: 0 }))}
      onPreviewExternalImport={onPreviewExternalImport}
      onApplyExternalImport={onApplyExternalImport}
      onExportOpenSsh={vi.fn(async () => new Blob(['Host app']))}
      onExportCsv={vi.fn(async () => new Blob(['name,address']))}
    />);

    const source = new File(['name,host,user,password\napp,app.example.com,deploy,source-secret'], 'connections.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('外部配置文件'), source);
    await user.click(screen.getByRole('button', { name: '预览跨产品导入' }));

    expect(onPreviewExternalImport).toHaveBeenCalledWith([source], undefined);
    expect(screen.getByText('需要补录凭据')).toBeInTheDocument();
    expect(screen.queryByText('source-secret')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('为 app 补录密码'), 'filled-secret');
    await user.click(screen.getByRole('button', { name: '应用跨产品导入' }));
    expect(onApplyExternalImport).toHaveBeenCalledWith('preview-1', expect.objectContaining({
      selectedSourceIds: ['csv:1'],
      credentials: [{ sourceId: 'csv:1', credential: { type: 'password', password: 'filled-secret' } }]
    }));
  });
});
