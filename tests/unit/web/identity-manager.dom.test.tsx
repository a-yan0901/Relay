// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdentityMetadata } from '../../../src/shared/core/models.js';
import { IdentityManager } from '../../../src/web/components/IdentityManager';

const identity: IdentityMetadata = {
  id: 'identity-1', name: 'Production deploy', type: 'password', username: 'deploy', keyFingerprint: null,
  usageCount: 2, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
};

describe('IdentityManager', () => {
  afterEach(() => cleanup());

  it('shows reusable identity metadata and creates a credential without rendering secret values', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<IdentityManager identities={[identity]} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Production deploy')).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'deploy · 密码 · 2 台 Server 使用中')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建身份' }));
    await user.type(screen.getByLabelText('身份名称'), 'Staging ops');
    await user.type(screen.getByLabelText('身份用户名'), 'ops');
    await user.type(screen.getByLabelText('身份密码'), 'identity-secret');
    await user.click(screen.getByRole('button', { name: '保存身份' }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Staging ops', type: 'password', username: 'ops', auth: { type: 'password', password: 'identity-secret' }
    }));
    expect(screen.queryByText('identity-secret')).not.toBeInTheDocument();
  });
});
