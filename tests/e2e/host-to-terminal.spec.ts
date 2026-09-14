import { expect, test } from '@playwright/test';

import { startE2eSshFixture, type E2eSshFixture } from './ssh-fixture';

const MASTER_PASSWORD = 'webssh e2e master password';

test.describe('host to terminal journey', () => {
  let fixture: E2eSshFixture;

  test.beforeAll(async () => {
    fixture = await startE2eSshFixture();
  });

  test.afterAll(async () => {
    await fixture?.close();
  });

  test('initializes a vault, trusts a host key, opens two tabs, and locks', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await page.getByLabel('确认主密码', { exact: true }).fill(MASTER_PASSWORD);
    const setupResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith('/api/setup') && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: '创建 Vault' }).click();
    const setupResponse = await setupResponsePromise;
    expect(setupResponse.status(), await setupResponse.text()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '添加第一台 Server' }).click();
    await page.getByLabel('服务器名称').fill('Fixture SSH A');
    await page.getByLabel('IP / 域名').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(fixture.port));
    await page.getByLabel('用户名').fill(fixture.username);
    await page.getByLabel('密码').fill(fixture.password);
    await page.getByRole('button', { name: '保存 Server' }).click();
    await expect(page.getByText('Fixture SSH A')).toBeVisible();

    await page.getByRole('button', { name: '连接 Fixture SSH A' }).click();
    const hostKeyDialog = page.getByRole('dialog');
    await expect(hostKeyDialog).toContainText('127.0.0.1:');
    await expect(hostKeyDialog).toContainText('SHA256:');
    const initialTerminalPanelsHeight = await page.locator('.terminal-panels').evaluate((element) => element.getBoundingClientRect().height);
    await page.waitForTimeout(1_000);
    const delayedTerminalPanelsHeight = await page.locator('.terminal-panels').evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(delayedTerminalPanelsHeight - initialTerminalPanelsHeight)).toBeLessThanOrEqual(1);
    const dialogBox = await hostKeyDialog.boundingBox();
    if (!dialogBox) throw new Error('host key dialog should have a layout box');
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewportHeight);
    await hostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
    await expect(page.locator('.terminal-panel.is-active').getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });

    const terminalInput = page.locator('.terminal-panel.is-active textarea.xterm-helper-textarea');
    await terminalInput.click();
    await terminalInput.pressSequentially("printf 'web-ssh-e2e\\n'");
    await terminalInput.press('Enter');
    await expect(page.locator('.terminal-panel.is-active .terminal-canvas')).toContainText('web-ssh-e2e', { timeout: 15_000 });

    await page.getByRole('button', { name: '新建终端：Fixture SSH A' }).click();
    await expect(page.getByRole('tab', { name: '切换 Fixture SSH A · 2' })).toBeVisible();
    await expect(page.locator('.terminal-panel.is-active').getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
    const workspaceHeight = await page.locator('.terminal-workspace-shell').evaluate((element) => element.getBoundingClientRect().height);
    expect(workspaceHeight).toBeGreaterThan(580);

    await page.getByRole('button', { name: '← Server 列表' }).click();
    await page.getByRole('button', { name: '添加 Server', exact: true }).last().click();
    await page.getByLabel('服务器名称').fill('Fixture SSH B');
    await page.getByLabel('IP / 域名').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(fixture.port));
    await page.getByLabel('用户名').fill(fixture.username);
    await page.getByLabel('密码').fill(fixture.password);
    await page.getByRole('button', { name: '保存 Server' }).click();
    await page.getByRole('button', { name: '连接 Fixture SSH B' }).click();
    const secondHostKeyDialog = page.getByRole('dialog');
    await expect(secondHostKeyDialog).toBeVisible();
    await secondHostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
    await expect(page.locator('.terminal-panel.is-active').getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab')).toHaveCount(3);

    const rail = page.getByRole('complementary', { name: '终端 Server 列表' });
    await rail.getByRole('textbox', { name: '搜索 Server' }).fill('Fixture SSH B');
    await expect(rail.locator('.rail-hosts button')).toHaveCount(1);
    await expect(rail.locator('.rail-hosts button')).toContainText('Fixture SSH B');

    await page.getByRole('button', { name: '锁定' }).click();
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await expect(page.getByRole('button', { name: '连接 Fixture SSH A' })).toHaveCount(0);
  });
});
