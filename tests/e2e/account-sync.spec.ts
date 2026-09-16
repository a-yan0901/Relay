import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';
import BetterSqlite3 from 'better-sqlite3';

import { parseSyncConflictExport } from '../../src/shared/core/sync-conflict-export';
import type { SyncEnvelope } from '../../src/shared/core/models';
import { decryptSyncConflictExportCopy } from '../../src/server/sync/sync-conflict-export';
import { startE2eSshFixture, type E2eSshFixture } from './ssh-fixture';

const MASTER_PASSWORD = 'webssh e2e master password';
const ACCOUNT_EMAIL = 'relay-account-e2e@example.com';
const ACCOUNT_PASSWORD = 'relay account e2e password';
const LOCAL_SECRET_MARKER = 'vault-secret-marker-e2e';
const CONFLICT_EXPORT_PASSWORD = 'relay conflict export e2e password';
const DELETION_ACCOUNT_EMAIL = 'relay-account-deletion-e2e@example.com';
const DELETION_ACCOUNT_PASSWORD = 'relay account deletion e2e password';
const DELETION_LOCAL_HOST = 'Account deletion local host';

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
  const terminalBackButton = page.getByRole('button', { name: '← Server 列表' });
  await expect.poll(async () => {
    if (await setupButton.isVisible()) return 'setup';
    if (await unlockButton.isVisible()) return 'locked';
    if (await serverHeading.isVisible()) return 'ready';
    if (await terminalBackButton.isVisible()) return 'ready';
    return 'loading';
  }, { timeout: 15_000 }).toMatch(/setup|locked|ready/u);
  let workspaceLoaded: Promise<unknown> | undefined;
  if (await setupButton.isVisible()) {
    workspaceLoaded = page.waitForResponse((response) => response.url().endsWith('/api/workspace') && response.request().method() === 'GET' && response.status() === 200);
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await page.getByLabel('确认主密码', { exact: true }).fill(MASTER_PASSWORD);
    await setupButton.click();
  } else if (await unlockButton.isVisible()) {
    workspaceLoaded = page.waitForResponse((response) => response.url().endsWith('/api/workspace') && response.request().method() === 'GET' && response.status() === 200);
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await unlockButton.click();
  }
  if (workspaceLoaded) {
    await workspaceLoaded;
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  if (!await serverHeading.isVisible() && !await terminalBackButton.isVisible()) await expect(serverHeading).toBeVisible({ timeout: 15_000 });
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

const latestUnresolvedConflictId = (accountId: string): string | null => {
  const database = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite', { readonly: true });
  try {
    const row = database.prepare(`
      SELECT id
      FROM sync_conflicts
      WHERE account_id = ? AND resolved_at IS NULL
      ORDER BY rowid DESC
      LIMIT 1
    `).get(accountId) as { id: string } | undefined;
    return row?.id ?? null;
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
    const syncRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/account/')) accountRequests.push(request.url());
      if (request.url().includes('/api/sync/')) syncRequests.push(request.url());
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
    await expect(menu.getByRole('button', { name: '打开同步中心' })).toHaveCount(0);
    await page.waitForTimeout(250);
    expect(accountRequests).toEqual([]);
    expect(syncRequests).toEqual([]);
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

      const currentEnvelopeResponse = await readJson<{ envelope: SyncEnvelope }>(page, '/api/sync/v1/envelope');
      expect(currentEnvelopeResponse.status).toBe(200);
      const firstAccount = await readJson<{ account: { accountId: string } | null }>(page, '/api/account/session');
      const accountId = firstAccount.body.account?.accountId;
      if (!accountId) throw new Error('account session missing account id');
      const seededConflictId = 'e2e-conflict-export';
      const database = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite');
      try {
        database.prepare(`
          INSERT OR REPLACE INTO sync_conflicts (
            id, account_id, local_revision, remote_revision,
            local_envelope_json, remote_envelope_json, created_at, resolved_at
          ) VALUES (@id, @accountId, @localRevision, @remoteRevision, @local, @remote, @createdAt, NULL)
        `).run({
          id: seededConflictId,
          accountId,
          localRevision: (staleEnvelope as SyncEnvelope).revision,
          remoteRevision: currentEnvelopeResponse.body.envelope.revision,
          local: JSON.stringify(staleEnvelope),
          remote: JSON.stringify(currentEnvelopeResponse.body.envelope),
          createdAt: new Date().toISOString()
        });
        database.prepare(`
          INSERT INTO sync_client_state (account_id, pending_envelope_json, status, error_code, updated_at)
          VALUES (@accountId, @pending, 'conflict', 'SYNC_CONFLICT', @updatedAt)
          ON CONFLICT(account_id) DO UPDATE SET
            pending_envelope_json = excluded.pending_envelope_json,
            status = excluded.status,
            error_code = excluded.error_code,
            updated_at = excluded.updated_at
        `).run({ accountId, pending: JSON.stringify(staleEnvelope), updatedAt: new Date().toISOString() });
      } finally {
        database.close();
      }

      await ensureVaultReady(page);
      const exportMenu = await openAccountMenu(page);
      await exportMenu.getByRole('button', { name: '打开同步中心' }).click();
      const exportCenter = page.getByRole('dialog', { name: '同步中心' });
      await expect(exportCenter).toContainText('存在同步冲突，需要处理');
      const activeConflictId = latestUnresolvedConflictId(accountId);
      if (!activeConflictId) throw new Error('unresolved conflict missing after sync center opened');
      await exportCenter.getByRole('button', { name: '导出两份' }).click();
      await exportCenter.getByLabel('导出密码', { exact: true }).fill(CONFLICT_EXPORT_PASSWORD);
      await exportCenter.getByLabel('确认导出密码', { exact: true }).fill(CONFLICT_EXPORT_PASSWORD);
      const exportResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST' && response.url().includes(`/api/sync/v1/conflicts/${activeConflictId}/export`)
      ));
      const downloadPromise = page.waitForEvent('download');
      await exportCenter.getByRole('button', { name: '下载加密副本' }).click();
      const [exportResponse, download] = await Promise.all([exportResponsePromise, downloadPromise]);
      const exportRaw = await exportResponse.text();
      expect(exportResponse.status()).toBe(200);
      expect(exportRaw).not.toContain(CONFLICT_EXPORT_PASSWORD);
      expect(exportRaw).not.toContain(LOCAL_SECRET_MARKER);
      expect(download.suggestedFilename()).toBe(`relay-sync-conflict-${activeConflictId}.json`);
      const downloadPath = await download.path();
      if (!downloadPath) throw new Error('encrypted conflict export download path missing');
      const downloadedRaw = await readFile(downloadPath, 'utf8');
      expect(downloadedRaw).not.toContain(CONFLICT_EXPORT_PASSWORD);
      expect(downloadedRaw).not.toContain(LOCAL_SECRET_MARKER);
      const exported = parseSyncConflictExport(JSON.parse(downloadedRaw) as unknown);
      expect(exported.conflictId).toBe(activeConflictId);
      expect(exported.copies.map((copy) => copy.copy)).toEqual(['local', 'remote']);
      expect(exported.copies.map((copy) => copy.revision)).toEqual([1, 2]);
      const localSnapshot = JSON.parse((await decryptSyncConflictExportCopy(activeConflictId, exported.copies[0], CONFLICT_EXPORT_PASSWORD)).toString('utf8')) as Record<string, unknown>;
      const remoteSnapshot = JSON.parse((await decryptSyncConflictExportCopy(activeConflictId, exported.copies[1], CONFLICT_EXPORT_PASSWORD)).toString('utf8')) as Record<string, unknown>;
      expect(localSnapshot).toEqual(expect.objectContaining({ schemaVersion: 1, groups: expect.any(Array), hosts: expect.any(Array), identities: expect.any(Array), snippets: expect.any(Array), workspace: expect.any(Object) }));
      expect(remoteSnapshot).toEqual(expect.objectContaining({ schemaVersion: 1, groups: expect.any(Array), hosts: expect.any(Array), identities: expect.any(Array), snippets: expect.any(Array), workspace: expect.any(Object) }));
      expect(JSON.stringify(remoteSnapshot)).toContain(LOCAL_SECRET_MARKER);
      expect(exportCenter).toContainText('需要你选择冲突处理方式');
      expect(exportCenter.getByRole('button', { name: '保留本地' })).toBeVisible();
      expect(exportCenter.getByRole('button', { name: '使用远端' })).toBeVisible();

      const storedConflict = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite');
      try {
        const conflictRow = storedConflict.prepare('SELECT resolved_at, local_envelope_json, remote_envelope_json FROM sync_conflicts WHERE id = ?').get(seededConflictId) as { resolved_at: string | null; local_envelope_json: string; remote_envelope_json: string } | undefined;
        expect(conflictRow?.resolved_at).toBeNull();
        expect(conflictRow?.local_envelope_json).not.toContain(LOCAL_SECRET_MARKER);
        expect(conflictRow?.remote_envelope_json).not.toContain(LOCAL_SECRET_MARKER);
        const exportAudit = storedConflict.prepare(`SELECT metadata_json FROM audit_events WHERE event_type = 'sync_conflict_exported' ORDER BY created_at DESC LIMIT 1`).get() as { metadata_json: string } | undefined;
        expect(exportAudit?.metadata_json).toBeTruthy();
        expect(exportAudit?.metadata_json).not.toContain(CONFLICT_EXPORT_PASSWORD);
        expect(exportAudit?.metadata_json).not.toContain(LOCAL_SECRET_MARKER);
      } finally {
        storedConflict.close();
      }
      await exportCenter.getByRole('button', { name: '关闭同步中心' }).click();
      const cleanupConflicts = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite');
      try {
        cleanupConflicts.prepare('UPDATE sync_conflicts SET resolved_at = ? WHERE account_id = ? AND resolved_at IS NULL').run(new Date().toISOString(), accountId);
        cleanupConflicts.prepare('DELETE FROM sync_client_state WHERE account_id = ?').run(accountId);
      } finally {
        cleanupConflicts.close();
      }

      const terminalBack = page.getByRole('button', { name: '← Server 列表' });
      if (await terminalBack.isVisible()) await terminalBack.click();
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

  test('keeps local data through account and cloud deletion recovery and expiry', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => window.sessionStorage.removeItem('relay.terminal.descriptors.v1'));
    await ensureVaultReady(page);
    const serverHeading = page.getByRole('heading', { name: 'Server', exact: true });
    const terminalBackButton = page.getByRole('button', { name: '← Server 列表', exact: true });
    if (await terminalBackButton.isVisible()) await terminalBackButton.click();
    await expect(serverHeading).toBeVisible({ timeout: 15_000 });

    let menu = await openAccountMenu(page);
    if (await menu.getByRole('button', { name: '退出登录', exact: true }).isVisible()) {
      await menu.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('仅本地');
    }

    menu = await openAccountMenu(page);
    await menu.getByRole('button', { name: '创建新账号', exact: true }).click();
    await menu.getByLabel('账号邮箱', { exact: true }).fill(DELETION_ACCOUNT_EMAIL);
    await menu.getByLabel('账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
    await menu.getByLabel('设备名称').fill('Deletion browser');
    await menu.getByRole('button', { name: '注册', exact: true }).click();
    await expect(menu).toContainText('账号已登录');
    await menu.getByRole('button', { name: '关闭账号菜单', exact: true }).click();

    await addHost(page, DELETION_LOCAL_HOST, fixture);

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto('/');
      const secondMenu = await openAccountMenu(secondPage);
      await secondMenu.getByLabel('账号邮箱', { exact: true }).fill(DELETION_ACCOUNT_EMAIL);
      await secondMenu.getByLabel('账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await secondMenu.getByRole('button', { name: '登录', exact: true }).click();
      await expect(secondMenu).toContainText('账号已登录');

      menu = await openAccountMenu(page);
      await menu.getByRole('button', { name: '删除账号', exact: true }).click();
      const deleteAccountDialog = page.getByRole('dialog', { name: '确认删除账号', exact: true });
      await deleteAccountDialog.getByLabel('重新输入账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await deleteAccountDialog.getByLabel('输入确认文本', { exact: true }).fill('DELETE MY ACCOUNT');
      await deleteAccountDialog.getByRole('button', { name: '确认删除账号', exact: true }).click();
      await expect(menu).toContainText('账号删除已计划，本地 Vault 保留');
      await expect(page.getByText(DELETION_LOCAL_HOST, { exact: true })).toBeVisible();

      const revokedSession = await readJson<{ account: null }>(secondPage, '/api/account/session');
      expect(revokedSession.status).toBe(200);
      expect(revokedSession.body.account).toBeNull();
      expect(revokedSession.raw).not.toContain(DELETION_ACCOUNT_PASSWORD);
      const deletedSession = await readJson<{ account: null }>(page, '/api/account/session');
      expect(deletedSession.body.account).toBeNull();

      menu = await openAccountMenu(page);
      await menu.getByLabel('账号邮箱', { exact: true }).fill(DELETION_ACCOUNT_EMAIL);
      await menu.getByLabel('账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await menu.getByRole('button', { name: '登录', exact: true }).click();
      await expect(menu).toContainText('账号已登录');
      await expect(menu).toContainText('账号将在约 30 天后删除');
      const pendingDescriptor = await readJson<{ error?: { code?: string } }>(page, '/api/sync/v1/descriptor');
      expect(pendingDescriptor.status).toBe(409);
      expect(pendingDescriptor.body.error?.code).toBe('ACCOUNT_DELETION_PENDING');

      await menu.getByRole('button', { name: '恢复账号删除', exact: true }).click();
      const restoreAccountDialog = page.getByRole('dialog', { name: '恢复账号删除', exact: true });
      await restoreAccountDialog.getByLabel('重新输入账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await restoreAccountDialog.getByLabel('输入确认文本', { exact: true }).fill('RESTORE ACCOUNT');
      await restoreAccountDialog.getByRole('button', { name: '确认恢复账号删除', exact: true }).click();
      await expect(menu).toContainText('账号删除已恢复');
      const restoredAccountDeletion = await readJson<{ deletion: null }>(page, '/api/account/deletion');
      expect(restoredAccountDeletion.body).toEqual({ deletion: null });

      await expect(menu.getByRole('button', { name: '打开同步中心', exact: true })).toBeVisible({ timeout: 15_000 });
      await menu.getByRole('button', { name: '打开同步中心', exact: true }).click();
      const restoredSyncCenter = page.getByRole('dialog', { name: '同步中心', exact: true });
      await restoredSyncCenter.getByRole('button', { name: '启用加密同步', exact: true }).click();
      await expect(restoredSyncCenter).toContainText('已同步');
      await restoredSyncCenter.getByRole('button', { name: '关闭同步中心', exact: true }).click();

      menu = await openAccountMenu(page);
      await menu.getByRole('button', { name: '删除云端同步数据', exact: true }).click();
      const deleteCloudDialog = page.getByRole('dialog', { name: '确认删除云端同步数据', exact: true });
      await deleteCloudDialog.getByLabel('重新输入账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await deleteCloudDialog.getByLabel('输入确认文本', { exact: true }).fill('DELETE MY CLOUD VAULT');
      await deleteCloudDialog.getByRole('button', { name: '确认删除云端同步数据', exact: true }).click();
      await expect(menu).toContainText('云端同步数据已计划删除，本地 Vault 保留');
      await expect(menu).toContainText('云端同步数据将在约 30 天后删除');
      const pendingCloudState = await readJson<{ sync: string; head: null; deletion: { kind: string } }>(page, '/api/sync/v1/state');
      expect(pendingCloudState.body).toMatchObject({ sync: 'local-only', head: null, pendingCount: 0, deletion: { kind: 'cloud-sync' } });
      const blockedCloudDescriptor = await readJson<{ error?: { code?: string } }>(page, '/api/sync/v1/descriptor');
      expect(blockedCloudDescriptor.status).toBe(409);
      expect(blockedCloudDescriptor.body.error?.code).toBe('SYNC_DELETE_PENDING');

      await menu.getByRole('button', { name: '恢复云端删除', exact: true }).click();
      const restoreCloudDialog = page.getByRole('dialog', { name: '恢复云端删除', exact: true });
      await restoreCloudDialog.getByLabel('重新输入账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await restoreCloudDialog.getByLabel('输入确认文本', { exact: true }).fill('RESTORE CLOUD DATA');
      await restoreCloudDialog.getByRole('button', { name: '确认恢复云端删除', exact: true }).click();
      await expect(menu).toContainText('云端同步数据删除已恢复');
      const restoredCloudState = await readJson<{ sync: string; deletion?: unknown }>(page, '/api/sync/v1/state');
      expect(restoredCloudState.body.sync).toBe('synced');
      expect(restoredCloudState.body).not.toHaveProperty('deletion');

      await menu.getByRole('button', { name: '删除账号', exact: true }).click();
      const deleteAgainDialog = page.getByRole('dialog', { name: '确认删除账号', exact: true });
      await deleteAgainDialog.getByLabel('重新输入账号密码', { exact: true }).fill(DELETION_ACCOUNT_PASSWORD);
      await deleteAgainDialog.getByLabel('输入确认文本', { exact: true }).fill('DELETE MY ACCOUNT');
      await deleteAgainDialog.getByRole('button', { name: '确认删除账号', exact: true }).click();
      await expect(menu).toContainText('账号删除已计划，本地 Vault 保留');

      const database = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite');
      try {
        const accountRow = database.prepare('SELECT id FROM accounts WHERE email = ?').get(DELETION_ACCOUNT_EMAIL) as { id: string } | undefined;
        if (!accountRow) throw new Error('deletion account missing before expiry update');
        database.prepare('UPDATE account_delete_requests SET delete_after = ? WHERE account_id = ?').run(new Date(Date.now() - 1_000).toISOString(), accountRow.id);
      } finally {
        database.close();
      }

      const expiredSession = await readJson<{ account: null }>(page, '/api/account/session');
      expect(expiredSession.body.account).toBeNull();
      expect(expiredSession.raw).not.toContain(DELETION_ACCOUNT_PASSWORD);
      await expect(page.getByText(DELETION_LOCAL_HOST, { exact: true })).toBeVisible();

      const verificationDatabase = new BetterSqlite3('.tmp-e2e-account-data/webssh.sqlite', { readonly: true });
      try {
        expect(verificationDatabase.prepare('SELECT id FROM accounts WHERE email = ?').get(DELETION_ACCOUNT_EMAIL)).toBeUndefined();
        expect(verificationDatabase.prepare('SELECT id FROM hosts WHERE name = ?').get(DELETION_LOCAL_HOST)).toBeTruthy();
        const auditRows = verificationDatabase.prepare('SELECT metadata_json FROM audit_events').all() as Array<{ metadata_json: string }>;
        expect(auditRows.every((row) => !row.metadata_json.includes(DELETION_ACCOUNT_PASSWORD))).toBe(true);
      } finally {
        verificationDatabase.close();
      }
    } finally {
      await secondContext.close();
    }
  });
});
