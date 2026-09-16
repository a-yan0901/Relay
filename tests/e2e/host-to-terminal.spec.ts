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
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    });
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
    await page.getByLabel('服务器名称').press('Control+Shift+P');
    await expect(page.getByRole('dialog', { name: '命令片段' })).toHaveCount(0);
    await page.getByLabel('服务器名称').fill('Fixture SSH A');
    await page.getByLabel('IP / 域名').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(fixture.port));
    await page.getByLabel('用户名').fill(fixture.username);
    await page.getByLabel('密码').fill(fixture.password);
    await page.getByRole('button', { name: '保存 Server' }).click();
    await expect(page.getByText('Fixture SSH A')).toBeVisible();

    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: '快速切换' })).toBeVisible();
    await expect(page.locator('#quick-switcher-search')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '连接 Fixture SSH A', exact: true }).click();
    const hostKeyDialog = page.getByRole('dialog');
    await expect(hostKeyDialog).toContainText('127.0.0.1:');
    await expect(hostKeyDialog).toContainText('SHA256:');
    const initialTerminalPanelsHeight = await page.locator('.terminal-layout').evaluate((element) => element.getBoundingClientRect().height);
    await page.waitForTimeout(1_000);
    const delayedTerminalPanelsHeight = await page.locator('.terminal-layout').evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(delayedTerminalPanelsHeight - initialTerminalPanelsHeight)).toBeLessThanOrEqual(1);
    const dialogBox = await hostKeyDialog.boundingBox();
    if (!dialogBox) throw new Error('host key dialog should have a layout box');
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewportHeight);
    await hostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
    await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
    await expect(page.locator('.terminal-topbar .app-header-embedded')).toBeVisible();
    await expect(page.locator('.terminal-topbar .brand-lockup strong')).toHaveText('Relay');
    await expect(page.getByRole('toolbar', { name: '终端导航与工作区操作' })).toBeVisible();
    await expect(page.getByRole('button', { name: '锁定' })).toBeVisible();
    await expect(page.getByRole('button', { name: '偏好设置' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建终端' })).toHaveCount(1);
    await expect(page.locator('.terminal-topbar .terminal-toolbar')).toBeVisible();
    await expect(page.locator('.terminal-panel.is-active .terminal-panel-heading')).toHaveCount(0);
    const terminalTopbarHeight = await page.locator('.terminal-topbar').evaluate((element) => element.getBoundingClientRect().height);
    expect(terminalTopbarHeight).toBeLessThanOrEqual(44);
    const terminalInput = page.locator('.terminal-panel.is-active textarea.xterm-helper-textarea');
    await expect(terminalInput).toBeFocused();
    await terminalInput.pressSequentially("printf '\\033[2J\\033[Hmobile-copy-target\\n'");
    await terminalInput.press('Enter');
    await expect(page.locator('.terminal-panel.is-active .terminal-canvas')).toContainText('mobile-copy-target', { timeout: 15_000 });
    const terminalElement = page.locator('.terminal-panel.is-active .xterm-screen');
    const terminalBounds = await terminalElement.boundingBox();
    if (!terminalBounds) throw new Error('terminal should have a layout box');
    const cellWidth = terminalBounds.width / 80;
    const cellHeight = terminalBounds.height / 24;
    await page.mouse.click(
      terminalBounds.x + cellWidth * 5.5,
      terminalBounds.y + cellHeight * 0.5,
      { button: 'right' }
    );
    await expect(terminalInput).toHaveValue('mobile-copy-target');
    await expect(terminalInput).toBeFocused();
    const scrollPolicy = await page.locator('.terminal-panel.is-active .terminal-canvas .xterm-viewport').evaluate((element) => ({
      rootOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
      bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
      viewportOverscroll: getComputedStyle(element).overscrollBehaviorY,
      viewportOverflowY: getComputedStyle(element).overflowY,
      viewportTouchAction: getComputedStyle(element).touchAction,
      terminalTouchAction: getComputedStyle(element.closest('.xterm') as Element).touchAction
    }));
    expect(scrollPolicy.rootOverscroll).toBe('none');
    expect(scrollPolicy.bodyOverscroll).toBe('none');
    expect(scrollPolicy.viewportOverscroll).toBe('contain');
    expect(['auto', 'scroll']).toContain(scrollPolicy.viewportOverflowY);
    expect(scrollPolicy.viewportTouchAction).toBe('pan-y');
    expect(scrollPolicy.terminalTouchAction).toBe('pan-y');
    await page.getByRole('button', { name: '← Server 列表' }).click();
    await expect(page.getByText('指纹已验证', { exact: true })).toBeVisible();
    await expect(page.locator('.host-last-connected')).toContainText('最近连接：');
    const quickSwitcher = page.getByRole('button', { name: '快速切换' });
    await quickSwitcher.click();
    await page.getByRole('dialog', { name: '快速切换' }).getByRole('option').filter({ hasText: '打开 Console' }).click();
    await page.getByRole('button', { name: '快速切换' }).click();
    await expect(page.getByRole('dialog', { name: '快速切换' })).toBeVisible();
    await expect(page.locator('#quick-switcher-search')).toBeFocused();
    await page.keyboard.press('Escape');

    await terminalInput.click();
    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: '快速切换' })).toHaveCount(0);
    await expect(terminalInput).toBeFocused();
    await terminalInput.pressSequentially("printf 'web-ssh-e2e\\n'");
    await terminalInput.press('Enter');
    await expect(page.locator('.terminal-panel.is-active .terminal-canvas')).toContainText('web-ssh-e2e', { timeout: 15_000 });

    await page.getByRole('button', { name: '新建终端' }).first().click();
    await page.getByRole('dialog', { name: '选择 Server' }).getByRole('button', { name: '新建终端：Fixture SSH A' }).click();
    await expect(page.getByRole('tab', { name: '切换 Fixture SSH A · 2' })).toBeVisible();
    await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
    const workspaceHeight = await page.locator('.terminal-workspace-shell').evaluate((element) => element.getBoundingClientRect().height);
    expect(workspaceHeight).toBeGreaterThan(580);

    await page.reload();
    await expect(page.getByRole('tab', { name: '切换 Fixture SSH A · 1' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: '切换 Fixture SSH A · 2' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '← Server 列表' }).click();
    await page.getByRole('button', { name: '添加 Server', exact: true }).last().click();
    await page.getByLabel('服务器名称').fill('Fixture SSH B');
    await page.getByLabel('IP / 域名').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(fixture.port));
    await page.getByLabel('用户名').fill(fixture.username);
    await page.getByLabel('密码').fill(fixture.password);
    await page.getByRole('button', { name: '保存 Server' }).click();
    await page.getByRole('button', { name: '连接 Fixture SSH B', exact: true }).click();
    const secondHostKeyDialog = page.getByRole('dialog');
    await expect(secondHostKeyDialog).toBeVisible();
    await secondHostKeyDialog.getByRole('button', { name: '信任并连接' }).click();
    await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
    await expect(page.getByRole('tab')).toHaveCount(3);
    await page.keyboard.press('Control+W');
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.getByRole('button', { name: '新建终端' }).first().click();
    const hostPicker = page.getByRole('dialog', { name: '选择 Server' });
    await hostPicker.getByRole('textbox', { name: '搜索 Server' }).fill('Fixture SSH B');
    await expect(hostPicker.getByRole('button', { name: '新建终端：Fixture SSH B' })).toHaveCount(1);

    await page.getByRole('button', { name: '关闭 Server 选择器' }).click();
    await page.getByRole('button', { name: '左右分屏' }).click();
    await expect(page.locator('.terminal-pane.is-visible')).toHaveCount(2);
    await expect(page.getByRole('separator', { name: '调整左右分屏大小' })).toBeVisible();
    await page.getByRole('button', { name: '上下分屏' }).click();
    await expect(page.getByRole('separator', { name: '调整上下分屏大小' })).toBeVisible();
    await page.getByRole('button', { name: '退出分屏' }).click();

    await page.getByRole('button', { name: '锁定' }).click();
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await expect(page.getByRole('button', { name: '连接 Fixture SSH A' })).toHaveCount(0);
    await page.getByLabel('主密码', { exact: true }).fill(MASTER_PASSWORD);
    await page.getByRole('button', { name: '解锁 Vault' }).click();
    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加 Server', exact: true }).click();
    await page.getByLabel('服务器名称').fill('Long Hostname');
    await page.getByLabel('IP / 域名').fill('very-long-hostname.internal.example.com');
    await page.getByLabel('用户名').fill('ops');
    await page.getByLabel('密码').fill('fixture-password');
    await page.getByRole('button', { name: '保存 Server' }).click();
    await page.setViewportSize({ width: 320, height: 720 });
    const narrowCard = page.locator('.host-card').filter({ hasText: 'Long Hostname' });
    await expect(narrowCard).toBeVisible();
    const narrowCardRight = await narrowCard.evaluate((element) => element.getBoundingClientRect().right);
    expect(narrowCardRight).toBeLessThanOrEqual(320);

    await page.setViewportSize({ width: 1024, height: 720 });
    await page.getByRole('button', { name: '偏好设置' }).click();
    await expect(page.getByRole('region', { name: '快捷键' })).toBeVisible();
    await page.getByRole('combobox', { name: '色彩主题' }).selectOption('contrast');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await page.getByRole('button', { name: '关闭偏好设置' }).click();

    await page.setViewportSize({ width: 390, height: 430 });
    await page.getByRole('button', { name: '连接 Fixture SSH A', exact: true }).click();
    await expect(page.locator('.terminal-tab.is-active .terminal-tab-status')).toHaveText('已连接', { timeout: 15_000 });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 430 });
      const shortViewportLayout = await page.evaluate(() => ({
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        layoutHeight: document.querySelector('.terminal-layout')?.getBoundingClientRect().height ?? 0,
        topbarHeight: document.querySelector('.terminal-topbar')?.getBoundingClientRect().height ?? 0
      }));
      expect(shortViewportLayout.documentWidth).toBeLessThanOrEqual(shortViewportLayout.width);
      expect(shortViewportLayout.bodyWidth).toBeLessThanOrEqual(shortViewportLayout.width);
      expect(shortViewportLayout.layoutHeight).toBeGreaterThan(260);
      expect(shortViewportLayout.topbarHeight).toBeLessThanOrEqual(38);
    }
  });
});
