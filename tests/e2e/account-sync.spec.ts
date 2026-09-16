import { expect, test, type Locator, type Page } from '@playwright/test';
import BetterSqlite3 from 'better-sqlite3';

import { startE2eSshFixture, type E2eSshFixture } from './ssh-fixture';

const MASTER_PASSWORD = 'webssh e2e master password';
const ACCOUNT_EMAIL = 'relay-account-e2e@example.com';
const ACCOUNT_PASSWORD = 'relay account e2e password';
const LOCAL_SECRET_MARKER = 'vault-secret-marker-e2e';

test.describe.configure({ mode: 'serial' });

const openAccountMenu = async (page: Page): Promise<Locator> => {
  const trigger = page.getByRole('button', { name: '账号菜单', exact: true });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const menu = page.getByRole('dialog', { name: '账号与同步' });
  await expect(menu).toBeVisible();
  return menu;
};

const ensureVaultReady = async (page: Page): Promise<void> => {
  await page.goto('/');
  const setupButton = page.getByRole('button', { name: '创建 Vault' });
  const unlockButton = page.getByRole('button', { name: '解锁 Vault' });
  const serverHeading = page.getByRole('heading', { name: 'Server', exact: true });
  await expect.poll(async () => {
    if (await setupButton.isVisible()) return 'setup';
    if (await unlockButton.isVisible()) return 'locked';
    if (await serverHeading.isVisible()) return 'ready';
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
  if (!await serverHeading.isVisible()) await expect(serverHeading).toBeVisible({ timeout: 15_000 });
};

const addHost = async (page: Page, name: string, fixture: E2eSshFixture, password = fixture.password): Promise<void> => {
  await page.getByRole('button', { name: /添加.*Server/u }).first().click();
  await page.getByLabel('服务器名称').fill(name);
  await page.getByLabel('IP / 域名').fill('127.0.0.1');
  await page.getByLabel('端口').fill(String(fixture.port));
  await page.getByLabel('用户名').fill(fixture.username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '保存 Server' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
};

const connectHost = async (page: Page, name: string, fixture: E2eSshFixture): Promise<void> => {
  await page.getByRole('button', { name: `连接 ${name}`, exact: true }).click();
  const hostKeyDialog = page.getByRole('dialog').filter({ hasText: 'SHA256:' });
  await expect(hostKeyDialog).toBeVisible({ timeout: 15_000 });
  await hostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
  await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
  expect(fixture.port).toBeGreaterThan(0);
};

const readJson = async <T>(page: Page, url: string): Promise<{ status: number; body: T; raw: string }> => (
  page.evaluate(async (target) => {
    const response = await fetch(target);
    const raw = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { /* response is intentionally opaque or malformed */ }
    return { status: response.status, body: body as T, raw };
  }, url)
);

const resetLocalVaultForNewDevice = (): void => {
  const database = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite');
  try {
    database.pragma('foreign_keys = ON');
    database.exec('DELETE FROM audit_events; DELETE FROM hosts; DELETE FROM groups; DELETE FROM identities; DELETE FROM snippets; DELETE FROM workspace_snapshots; DELETE FROM app_config;');
  } finally {
    database.close();
  }
};

test.describe('account and encrypted sync boundaries', () => {
  let fixture: E2eSshFixture;

  test.beforeAll(async () => {
    fixture = await startE2eSshFixture();
  });

  test.afterAll(async () => {
    await fixture?.close();
  });

  test('keeps Local-only when the server does not advertise account capabilities', async ({ page }) => {
    const accountRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/account/')) accountRequests.push(request.url());
    });
    await page.route('**/api/capabilities', async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as { capabilities: string[] };
      await route.fulfill({
        response,
        json: {
          ...payload,
          capabilities: payload.capabilities.filter((capability) => !['account.auth', 'device.trust', 'sync.encrypted'].includes(capability))
        }
      });
    });

    await ensureVaultReady(page);
    const menu = await openAccountMenu(page);
    await expect(menu).toContainText('账号服务未启用');
    await page.waitForTimeout(250);
    expect(accountRequests).toEqual([]);
  });

  test('registers while locked, syncs opaque data across contexts, and preserves local state after revoke/logout', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible({ timeout: 15_000 });

    const lockedMenu = await openAccountMenu(page);
    await lockedMenu.getByRole('button', { name: '创建新账号' }).click();
    await lockedMenu.getByLabel('账号邮箱').fill(ACCOUNT_EMAIL);
    await lockedMenu.getByLabel('账号密码').fill(ACCOUNT_PASSWORD);
    await lockedMenu.getByLabel('设备名称').fill('第一台浏览器');
    await lockedMenu.getByRole('button', { name: '注册' }).click();
    await expect(lockedMenu).toContainText('账号已登录');

    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await page.getByRole('button', { name: '解锁 Vault' }).click();
    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible({ timeout: 15_000 });
    await addHost(page, 'Account sync local host', fixture);
    await connectHost(page, 'Account sync local host', fixture);

    const firstMenu = await openAccountMenu(page);
    await firstMenu.getByRole('button', { name: '打开同步中心' }).click();
    const syncCenter = page.getByRole('dialog', { name: '同步中心' });
    await expect(syncCenter).toContainText('仅本地，不同步');
    await syncCenter.getByRole('button', { name: '启用加密同步' }).click();
    await expect(syncCenter).toContainText('已同步');
    await expect(syncCenter).toContainText('云端版本');
    await expect(syncCenter).toContainText('r1');

    const envelopeResponse = await readJson<{ envelope: Record<string, unknown> }>(page, '/api/sync/v1/envelope');
    expect(envelopeResponse.status).toBe(200);
    expect(envelopeResponse.body.envelope).toEqual(expect.objectContaining({ ciphertext: expect.any(String), nonce: expect.any(String) }));
    expect(envelopeResponse.raw).not.toContain(MASTER_PASSWORD);
    expect(envelopeResponse.raw).not.toContain(ACCOUNT_PASSWORD);
    expect(envelopeResponse.raw).not.toContain(fixture.password);
    const staleEnvelope = envelopeResponse.body.envelope;

    await syncCenter.getByRole('button', { name: '关闭同步中心' }).click();
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto('/');
      await expect(secondPage.getByRole('heading', { name: '欢迎回来' })).toBeVisible({ timeout: 15_000 });
      const secondMenu = await openAccountMenu(secondPage);
      await secondMenu.getByLabel('账号邮箱').fill(ACCOUNT_EMAIL);
      await secondMenu.getByLabel('账号密码').fill(ACCOUNT_PASSWORD);
      await secondMenu.getByRole('button', { name: '登录' }).click();
      await expect(secondMenu).toContainText('账号已登录');
      await expect(secondMenu.locator('.account-devices li')).toHaveCount(2, { timeout: 15_000 });

      await secondMenu.getByRole('button', { name: '打开同步中心' }).click();
      const secondSyncCenter = secondPage.getByRole('dialog', { name: '同步中心' });
      await expect(secondSyncCenter).toContainText('账号已登录，请先解锁 Vault');
      await expect(secondSyncCenter).toContainText('r1');
      await secondSyncCenter.getByRole('button', { name: '关闭同步中心' }).click();

      await secondPage.getByLabel('主密码', { exact: true }).fill('wrong vault password');
      await secondPage.getByRole('button', { name: '解锁 Vault' }).click();
      await expect(secondPage.getByRole('alert')).toContainText('主密码错误');
      await expect(secondPage.getByRole('heading', { name: '欢迎回来' })).toBeVisible();

      const accountSession = await readJson<{ account: { deviceId: string } | null }>(secondPage, '/api/account/session');
      expect(accountSession.body.account?.deviceId).toBeTruthy();

      await firstMenu.getByRole('button', { name: '关闭账号菜单' }).click();
      await page.getByRole('button', { name: '← Server 列表' }).click();
      await addHost(page, 'Account sync revision host', fixture, LOCAL_SECRET_MARKER);
      await expect.poll(async () => {
        const state = await readJson<{ head: { revision: number } | null }>(page, '/api/sync/v1/state');
        return state.body.head?.revision ?? 0;
      }, { timeout: 15_000 }).toBe(2);

      const conflict = await secondPage.evaluate(async ({ envelope, deviceId }) => {
        const response = await fetch('/api/sync/v1/envelope', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-stale-revision' },
          body: JSON.stringify({ ...envelope, deviceId })
        });
        return { status: response.status, body: await response.json() as { error?: { code?: string } } };
      }, { envelope: staleEnvelope, deviceId: accountSession.body.account?.deviceId });
      expect(conflict).toEqual({ status: 409, body: { error: expect.objectContaining({ code: 'SYNC_CONFLICT' }) } });
      const headAfterConflict = await readJson<{ head: { revision: number } | null }>(page, '/api/sync/v1/state');
      expect(headAfterConflict.body.head?.revision).toBe(2);

      const firstAccountMenu = await openAccountMenu(page);
      const secondDevice = firstAccountMenu.locator('.account-devices li').filter({ hasNotText: '· 当前' }).first();
      await expect(secondDevice).toBeVisible();
      await secondDevice.getByRole('button', { name: '撤销' }).click();
      await expect(secondDevice).toHaveCount(0);

      const revokedSync = await readJson<{ error?: { code?: string } }>(secondPage, '/api/sync/v1/state');
      expect(revokedSync.status).toBe(401);
      await secondPage.reload();
      const revokedMenu = await openAccountMenu(secondPage);
      await expect(revokedMenu).toContainText('仅本地，不同步');
      await expect(revokedMenu.getByRole('button', { name: '打开同步中心' })).toHaveCount(0);

      await firstAccountMenu.getByRole('button', { name: '退出登录' }).click();
      await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('仅本地');
      await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接');
      await expect(page.getByText('Account sync local host', { exact: true })).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });

  test('restores a reset local Vault through the new-device preview flow', async ({ page }) => {
    test.setTimeout(120_000);
    resetLocalVaultForNewDevice();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '建立你的 Server Vault' })).toBeVisible({ timeout: 15_000 });
    const menu = await openAccountMenu(page);
    await menu.getByLabel('账号邮箱').fill(ACCOUNT_EMAIL);
    await menu.getByLabel('账号密码').fill(ACCOUNT_PASSWORD);
    await menu.getByRole('button', { name: '登录' }).click();
    await expect(menu).toContainText('账号已登录');

    await page.getByRole('button', { name: '使用同步恢复' }).click();
    await expect(page.getByRole('heading', { name: '恢复云端 Vault' })).toBeVisible();
    await page.getByRole('button', { name: '原 Vault 主密码' }).click();
    await page.getByLabel('恢复密钥或原 Vault 主密码').fill(MASTER_PASSWORD);
    await page.getByRole('button', { name: '预览恢复内容' }).click();
    await expect(page.locator('.sync-recovery-preview')).toContainText('将恢复 2 台 Server');
    await page.getByRole('button', { name: '创建本地 Vault 并应用' }).click();

    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Account sync local host', { exact: true })).toBeVisible();
    await expect(page.getByText('Account sync revision host', { exact: true })).toBeVisible();
  });
});
