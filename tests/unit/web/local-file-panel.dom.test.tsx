// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalFilePanel } from '../../../src/web/components/LocalFilePanel';

describe('LocalFilePanel', () => {
  afterEach(() => cleanup());

  it('routes multiple picker files to the current remote directory', async () => {
    const user = userEvent.setup();
    const onFilesSelected = vi.fn(async () => {});
    render(<LocalFilePanel remotePath="/srv/releases" onFilesSelected={onFilesSelected} />);

    const files = [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' })
    ];
    await user.upload(screen.getByLabelText('选择本地文件'), files);

    expect(screen.getByRole('heading', { name: '本地文件' })).toBeInTheDocument();
    expect(screen.getByText('目标目录：/srv/releases')).toBeInTheDocument();
    expect(onFilesSelected).toHaveBeenCalledWith(files);
  });

  it('accepts dropped files and exposes the hit directory to assistive technology', () => {
    const onFilesSelected = vi.fn();
    render(<LocalFilePanel remotePath="/var/www" onFilesSelected={onFilesSelected} />);

    const file = new File(['payload'], 'release.bin', { type: 'application/octet-stream' });
    const dropTarget = screen.getByRole('button', { name: '拖放文件到 /var/www' });
    fireEvent.drop(dropTarget, { dataTransfer: { files: [file] } });

    expect(onFilesSelected).toHaveBeenCalledWith([file]);
  });
});
