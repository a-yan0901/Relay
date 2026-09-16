import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { startE2eSshFixture, type E2eSshFixture } from './ssh-fixture';

const MASTER_PASSWORD = 'webssh e2e master password';

test.describe.configure({ mode: 'serial' });

const waitForReady = async (page: Page): Promise<void> => {
  await page.goto('/');
  const setupButton = page.getByRole('button', { name: '创建 Vault' });
  const unlockButton = page.getByRole('button', { name: '解锁 Vault' });
  const serverHeading = page.getByRole('heading', { name: 'Server', exact: true });
  const terminalToolbar = page.getByRole('toolbar', { name: '终端导航与工作区操作' });
  await expect.poll(async () => {
    if (await setupButton.isVisible()) return 'setup';
    if (await unlockButton.isVisible()) return 'locked';
    if (await serverHeading.isVisible() || await terminalToolbar.isVisible()) return 'ready';
    return 'loading';
  }, { timeout: 15_000 }).toMatch(/setup|locked|ready/u);

  if (await setupButton.isVisible()) {
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await page.getByLabel('确认主密码', { exact: true }).fill(MASTER_PASSWORD);
    await setupButton.click();
  } else if (await unlockButton.isVisible()) {
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await unlockButton.click();
  }
  if (await terminalToolbar.isVisible()) return;
  await expect(serverHeading).toBeVisible({ timeout: 15_000 });
};

const addHost = async (page: Page, name: string, fixture: E2eSshFixture): Promise<void> => {
  await page.getByRole('button', { name: '添加 Server', exact: true }).click();
  await page.getByLabel('服务器名称').fill(name);
  await page.getByLabel('IP / 域名').fill('127.0.0.1');
  await page.getByLabel('端口').fill(String(fixture.port));
  await page.getByLabel('用户名').fill(fixture.username);
  await page.getByLabel('密码').fill(fixture.password);
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/hosts') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '保存 Server' }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
};

const trustAndWaitForConnection = async (page: Page): Promise<void> => {
  const hostKeyDialog = page.getByRole('dialog').filter({ hasText: 'SHA256:' });
  try {
    await hostKeyDialog.waitFor({ state: 'visible', timeout: 5_000 });
    await hostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
  } catch {
    // Reconnecting to a previously trusted host does not show a prompt.
  }
  await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
};

const clearWorkspace = async (page: Page): Promise<void> => {
  const current = await page.evaluate(async () => (await fetch('/api/workspace')).json() as { version: number });
  const response = await page.evaluate(async (version) => {
    const result = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: version,
      state: {
        version,
        tabs: [],
        activeTabId: null,
        layout: { mode: 'single', ratio: 0.5 },
        filters: { query: '', groupId: null, favoriteOnly: false }
      }
    })
    });
    return { status: result.status };
  }, current.version);
  expect(response.status).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible({ timeout: 15_000 });
};

test.describe('SSH productivity boundaries', () => {
  let fixture: E2eSshFixture;

  test.beforeAll(async () => {
    fixture = await startE2eSshFixture();
  });

  test.afterAll(async () => {
    await fixture?.close();
  });

  test('recovers workspaces, closes live sockets, completes SFTP, and audits batch execution', async ({ page }) => {
    test.setTimeout(180_000);
    await installSocketCapture(page);
    await disableFilePicker(page);
    await waitForReady(page);
    await clearWorkspace(page);

    const firstHost = 'Productivity SSH A';
    const secondHost = 'Productivity SSH B';
    await addHost(page, firstHost, fixture);
    await page.getByRole('button', { name: `连接 ${firstHost}`, exact: true }).click();
    await trustAndWaitForConnection(page);

    await page.getByRole('button', { name: '新建终端' }).click();
    await page.getByRole('dialog', { name: '选择 Server' }).getByRole('button', { name: `新建终端：${firstHost}` }).click();
    await trustAndWaitForConnection(page);
    await expect(page.getByRole('tab', { name: new RegExp(`切换 ${firstHost} · [12]`, 'u') })).toHaveCount(2);
    await page.getByRole('button', { name: '左右分屏' }).click();
    await expect(page.getByRole('separator', { name: '调整左右分屏大小' })).toBeVisible();

    await page.getByRole('button', { name: '远程文件' }).click();
    const filePanel = page.locator('.sftp-panel');
    await expect(filePanel.getByText('正在读取目录…')).toBeHidden({ timeout: 15_000 });
    await filePanel.getByRole('textbox', { name: '远程路径', exact: true }).fill(fixture.remoteDirectory);
    await filePanel.getByRole('button', { name: '跳转' }).click();
    await expect(filePanel.getByRole('button', { name: fixture.knownFileName, exact: true })).toBeVisible({ timeout: 15_000 });

    await filePanel.getByLabel('选择上传文件').setInputFiles({
      name: 'browser-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('browser-upload-content\n')
    });
    await expect(page.locator('.transfer-item')).toContainText(/已完成|completed/u, { timeout: 15_000 });
    await expect(filePanel.getByRole('button', { name: 'browser-upload.txt', exact: true })).toBeVisible({ timeout: 15_000 });

    const downloadPromise = page.waitForEvent('download');
    await filePanel.getByRole('button', { name: '下载 browser-upload.txt' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('browser-upload.txt');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!, 'utf8')).toBe('browser-upload-content\n');

    const hostResponse = await page.evaluate(async () => (await fetch('/api/hosts')).json() as Array<{ id: string; name: string }>);
    const firstHostId = hostResponse.find((host) => host.name === firstHost)?.id;
    if (!firstHostId) throw new Error('first host id is missing');
    const transfer = await page.request.post(`/api/sftp/${encodeURIComponent(firstHostId)}/transfers`, {
      data: { kind: 'upload', hostId: firstHostId, sourcePath: 'cancel.txt', targetPath: `${fixture.remoteDirectory}/cancel.txt`, totalBytes: 100 }
    });
    expect(transfer.status()).toBe(202);
    const transferJob = await transfer.json() as { id: string };
    expect((await page.request.delete(`/api/transfers/${encodeURIComponent(transferJob.id)}`)).status()).toBe(204);
    expect(await (await page.request.get(`/api/transfers/${encodeURIComponent(transferJob.id)}`)).json()).toMatchObject({ status: 'cancelled' });
    const directoryAfterCancel = await page.evaluate(async (path) => (await fetch(`/api/sftp/${encodeURIComponent(path.hostId)}/list?path=${encodeURIComponent(path.remoteDirectory)}`)).json() as Array<{ name: string }>, { hostId: firstHostId, remoteDirectory: fixture.remoteDirectory });
    expect(directoryAfterCancel.some((entry) => entry.name.includes('.relay-tmp-'))).toBe(false);

    await page.getByRole('button', { name: '← Server 列表' }).click();
    await clearWorkspace(page);
    await addHost(page, secondHost, fixture);
    await page.getByRole('button', { name: `连接 ${firstHost}`, exact: true }).click();
    await trustAndWaitForConnection(page);
    await page.getByRole('button', { name: '新建终端' }).click();
    await page.getByRole('dialog', { name: '选择 Server' }).getByRole('button', { name: `新建终端：${secondHost}` }).click();
    await trustAndWaitForConnection(page);
    await page.getByRole('button', { name: '左右分屏' }).click();
    await expect(page.getByRole('separator', { name: '调整左右分屏大小' })).toBeVisible();

    await page.getByRole('button', { name: '批量执行' }).click();
    const commandDialog = page.getByRole('dialog', { name: '批量执行' });
    await commandDialog.getByLabel('命令').fill("printf 'batch={{message}}\\n'; sleep 5");
    await commandDialog.locator('#command-variable-message').fill('e2e-ok');
    await commandDialog.locator('#command-concurrency').selectOption('1');
    await expect(commandDialog).toContainText('batch=e2e-ok');
    await commandDialog.getByRole('button', { name: '确认执行' }).click();
    const results = page.locator('.command-run-result-modal');
    await expect(results).toContainText('batch=e2e-ok');
    await expect(results.getByRole('button', { name: '取消批量任务' })).toBeVisible({ timeout: 5_000 });
    await results.getByRole('button', { name: '取消批量任务' }).click();
    await expect(results).toContainText('已取消', { timeout: 15_000 });
    await results.getByRole('button', { name: '关闭结果' }).click();

    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '活动' }).click();
    const activity = page.getByRole('dialog', { name: '最近活动' });
    await expect(activity).toContainText('批量任务', { timeout: 15_000 });
    await expect(activity).not.toContainText('e2e-ok');
  });

  test('restores a durable layout and reports a closed socket as reconnecting', async ({ page }) => {
    test.setTimeout(60_000);
    await installSocketCapture(page);
    await waitForReady(page);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole('separator', { name: '调整左右分屏大小' })).toBeVisible();
    await page.evaluate(() => {
      const sockets = (window as Window & { __relaySockets?: WebSocket[] }).__relaySockets ?? [];
      for (const socket of sockets.filter((candidate) => candidate.url.includes('/ws/terminal'))) socket.close();
    });
    await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText(/重连中|已断开|连接失败/u, { timeout: 1_000 });
    await expect(page.getByRole('button', { name: '新建终端' })).toBeVisible();
  });
});

const installSocketCapture = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const nativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(nativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        sockets.push(socket);
        return socket;
      }
    });
    (window as Window & { __relaySockets?: WebSocket[] }).__relaySockets = sockets;
  });
};

const disableFilePicker = async (page: Page): Promise<void> => {
  // Headless Chromium cannot open a user-writable picker; exercise the native download fallback.
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }));
};
