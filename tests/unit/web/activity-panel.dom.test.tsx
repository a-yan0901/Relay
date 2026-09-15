// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityPanel } from '../../../src/web/components/ActivityPanel';

describe('ActivityPanel', () => {
  afterEach(() => cleanup());

  it('shows safe activity summaries and an explicit expired-result state', () => {
    render(<ActivityPanel events={[
      { id: 'event-1', ownerId: 'owner-a', eventType: 'command_run_summary', hostId: null, requestId: 'req-1', remoteAddress: null, metadata: { runId: 'run-1', targetCount: 2, successCount: 1, failureCount: 1 }, createdAt: '2026-09-15T00:00:00.000Z' },
      { id: 'event-2', ownerId: 'owner-a', eventType: 'command_run_summary', hostId: null, requestId: 'req-2', remoteAddress: null, metadata: { runId: 'run-2', targetCount: 1, successCount: 1, failureCount: 0 }, createdAt: '2026-09-15T00:00:01.000Z' }
    ]} expiredRunIds={new Set(['run-2'])} onOpenRun={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '最近活动' })).toBeInTheDocument();
    expect(screen.getByText('批量任务 · 2 台主机 · 1 成功 / 1 失败')).toBeInTheDocument();
    expect(screen.getByText('结果已过期，需要重新执行')).toBeInTheDocument();
  });
});
