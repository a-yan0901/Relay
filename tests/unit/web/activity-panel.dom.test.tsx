// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityFilter } from '../../../src/shared/core/models';
import { ActivityPanel } from '../../../src/web/components/ActivityPanel';

describe('ActivityPanel', () => {
  afterEach(() => cleanup());

  it('shows safe activity summaries and an explicit expired-result state', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ActivityPanel onClose={onClose} events={[
      { id: 'event-1', ownerId: 'owner-a', eventType: 'command_run_summary', hostId: null, requestId: 'req-1', remoteAddress: null, metadata: { runId: 'run-1', targetCount: 2, successCount: 1, failureCount: 1, cancelledCount: 0 }, createdAt: '2026-09-15T00:00:00.000Z' },
      { id: 'event-2', ownerId: 'owner-a', eventType: 'command_run_summary', hostId: null, requestId: 'req-2', remoteAddress: null, metadata: { runId: 'run-2', targetCount: 1, successCount: 1, failureCount: 0 }, createdAt: '2026-09-15T00:00:01.000Z' }
    ]} expiredRunIds={new Set(['run-2'])} onOpenRun={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '最近活动' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭最近活动' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByText('批量任务 · 2 台主机 · 1 成功 / 1 失败')).toBeInTheDocument();
    expect(screen.getByText(/请求 req-1/u)).toBeInTheDocument();
    expect(screen.getByText('结果已过期，需要重新执行')).toBeInTheDocument();
  });

  it('keeps the next action visible beside a recent operation', () => {
    render(<ActivityPanel events={[
      { id: 'event-1', ownerId: 'owner-a', eventType: 'command_run_summary', hostId: null, requestId: 'req-1', remoteAddress: null, metadata: { runId: 'run-1', targetCount: 1, successCount: 0, failureCount: 1 }, createdAt: '2026-09-15T00:00:00.000Z' }
    ]} diagnostics={[{
      operationId: 'run-1', hostId: 'host-1', kind: 'command', stage: 'command', state: 'interrupted', retryable: true, nextAction: 'retry', errorCode: 'SERVICE_RESTARTED', startedAt: '2026-09-15T00:00:00.000Z', endedAt: '2026-09-15T00:00:01.000Z'
    }]} />);

    expect(screen.getByText(/执行命令 · 已中断 · 重试/u)).toBeInTheDocument();
  });

  it('applies searchable activity filters and loads the next page explicitly', async () => {
    const user = userEvent.setup();
    const onApplyFilter = vi.fn<(filter: ActivityFilter) => void>();
    const onLoadMore = vi.fn();
    render(<ActivityPanel
      events={[]}
      hosts={[{ id: 'host-1', name: 'Production API' }]}
      hasMore
      onApplyFilter={onApplyFilter}
      onLoadMore={onLoadMore}
    />);

    await user.selectOptions(screen.getByLabelText('筛选活动状态'), 'failed');
    await user.selectOptions(screen.getByLabelText('筛选活动主机'), 'host-1');
    await user.type(screen.getByLabelText('活动请求 ID'), 'request-1');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));

    expect(onApplyFilter).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', hostId: 'host-1', requestId: 'request-1', limit: 50 }));
    await user.click(screen.getByRole('button', { name: '加载更多活动' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
