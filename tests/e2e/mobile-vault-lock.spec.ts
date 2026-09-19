import { expect, test } from '@playwright/test';

import { startE2eSshFixture, type E2eSshFixture } from './ssh-fixture';

const MASTER_PASSWORD = 'webssh e2e master password';

test.describe('mobile Vault lock affordance', () => {
  let fixture: E2eSshFixture;

  test.beforeAll(async () => {
    fixture = await startE2eSshFixture();
  });

  test.afterAll(async () => {
    await fixture?.close();
  });

  test('keeps the compact lock action visible in the terminal topbar', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    });
    await page.goto('/');
    const setupButton = page.getByRole('button', { name: '创建 Vault' });
    const unlockButton = page.getByRole('button', { name: '解锁 Vault' });
    const serverHeading = page.getByRole('heading', { name: 'Server', exact: true });
    let initialView: 'loading' | 'setup' | 'locked' | 'servers' | 'terminal' = 'loading';
    await expect.poll(async () => {
      initialView = await setupButton.isVisible()
        ? 'setup'
        : await unlockButton.isVisible()
          ? 'locked'
          : await serverHeading.isVisible()
            ? 'servers'
            : await page.getByRole('button', { name: '← Server 列表', exact: true }).isVisible() ? 'terminal' : 'loading';
      return initialView;
    }, { timeout: 15_000 }).toMatch(/setup|locked|servers|terminal/u);
    if (await setupButton.isVisible()) {
      await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
      await page.getByLabel('确认主密码', { exact: true }).fill(MASTER_PASSWORD);
      await setupButton.click();
    } else if (await unlockButton.isVisible()) {
      await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
      await unlockButton.click();
    }

    await expect.poll(async () => (await page.request.get('/api/workspace')).status(), { timeout: 15_000 }).toBe(200);
    const workspace = await (await page.request.get('/api/workspace')).json() as { version: number };
    const resetWorkspaceResponse = await page.request.put('/api/workspace', {
      data: {
        expectedVersion: workspace.version,
        state: {
          version: workspace.version,
          tabs: [],
          activeTabId: null,
          layout: { mode: 'single', ratio: 0.5 },
          filters: { query: '', groupId: null, favoriteOnly: false }
        }
      }
    });
    expect(resetWorkspaceResponse.status(), await resetWorkspaceResponse.text()).toBe(200);
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
    await expect(serverHeading).toBeVisible({ timeout: 15_000 });

    const addFirstServerButton = page.getByRole('button', { name: '添加第一台 Server' });
    if (await addFirstServerButton.isVisible()) await addFirstServerButton.click();
    else await page.getByRole('button', { name: '添加 Server', exact: true }).click();
    await page.getByLabel('服务器名称', { exact: true }).fill('Mobile Lock Fixture');
    await page.getByLabel('IP / 域名').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(fixture.port));
    await page.getByLabel('用户名').fill(fixture.username);
    await page.getByLabel('密码').fill(fixture.password);
    await page.getByRole('button', { name: '保存 Server' }).click();
    await page.getByRole('button', { name: '进入 Console：Mobile Lock Fixture', exact: true }).click();

    const hostKeyDialog = page.getByRole('dialog');
    await expect(hostKeyDialog).toContainText('SHA256:');
    await hostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
    await expect(page.locator('.terminal-tab.is-active .status-dot-green')).toHaveCount(1, { timeout: 15_000 });

    await page.setViewportSize({ width: 320, height: 430 });
    const lockButton = page.getByRole('button', { name: 'Vault 已解锁，点击锁定' });
    await expect(lockButton).toBeVisible();
    await expect(lockButton).toHaveCSS('display', 'flex');
    const lockButtonBox = await lockButton.boundingBox();
    expect(lockButtonBox?.width ?? 0).toBeGreaterThan(0);
  });
});
