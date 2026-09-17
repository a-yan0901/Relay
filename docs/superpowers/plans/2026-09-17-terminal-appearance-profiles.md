# Terminal Appearance Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver Vault-synced terminal appearance profiles, one Vault default, and optional Server overrides without coupling terminal appearance to browser-local UI themes.

**Architecture:** Built-ins live in shared code. Custom profiles, the default reference, and Host assignment are Vault-scoped records. Bundle and sync share the profile payload. The web app resolves the selected profile and changes xterm.js options without recreating SSH terminals.

**Tech Stack:** TypeScript, React 19, Fastify 5, Zod 4, SQLite, xterm.js 6, Vitest.

**Spec:** docs/superpowers/specs/2026-09-17-terminal-appearance-profiles-design.md

## Global Constraints

- UI theme stays browser-local and never changes selected terminal profiles.
- Built-in IDs use builtin:<name>; custom IDs use existing safe identifiers and are owner-scoped.
- Appearance validation accepts normalized hex colors, safe font names, 10–24px, 1–2 line height, 500–20,000 scrollback, and block/bar/underline cursor styles.
- Existing Hosts inherit builtin:midnight from a nullable terminalProfileId.
- Bundle/sync readers accept legacy data with no profile fields.
- Do not stage src/server/ssh/ssh2-adapter.ts or tests/unit/server/ssh2-adapter.test.ts.

---

## File map

| File | Responsibility |
| --- | --- |
| src/shared/terminal-appearance.ts | Profile data types, built-ins, Zod schemas, resolution helpers. |
| src/server/db/{migrations,types,repositories}.ts | Profile/default/Host persistence. |
| src/server/terminal/terminal-profile-service.ts | Ownership and deletion invariants. |
| src/server/api/terminal-profile-routes.ts | Unlocked profile/default CRUD API. |
| src/server/workspace/vault-bundle-service.ts | Versioned encrypted profile payload. |
| src/server/sync/sync-snapshot.ts | Profile-aware snapshots. |
| src/web/components/TerminalProfile{Manager,Editor}.tsx | Settings management and preview. |
| src/web/components/{HostForm,TerminalWorkspace,TerminalPanel}.tsx | Host selection, effective appearance, live xterm updates. |

### Task 1: Appearance types and built-in resolution

**Files:**
- Create: src/shared/terminal-appearance.ts
- Modify: src/shared/validation.ts
- Test: tests/unit/shared/terminal-appearance.test.ts

**Produces:** TerminalAppearance, TerminalProfile, BUILTIN_TERMINAL_PROFILES, terminalAppearanceSchema, resolveTerminalProfile.

- [ ] **Step 1: Write the failing test.**

~~~ts
it('resolves a custom profile and rejects unsafe appearance input', () => {
  expect(resolveTerminalProfile('profile-ops', [profile('profile-ops')], 'builtin:midnight').id).toBe('profile-ops');
  expect(terminalAppearanceSchema.safeParse({ ...appearance(), foreground: 'rgba(0,0,0,.2)' }).success).toBe(false);
  expect(terminalAppearanceSchema.safeParse({ ...appearance(), fontFamily: 'mono\nscript' }).success).toBe(false);
});
~~~

- [ ] **Step 2: Verify RED.**

Run: npm test -- --run tests/unit/shared/terminal-appearance.test.ts
Expected: module/export not found.

- [ ] **Step 3: Implement the minimal shared model.**

~~~ts
export const terminalAppearanceSchema = z.object({
  foreground: hexColorSchema, background: hexColorSchema, cursor: hexColorSchema,
  cursorAccent: hexColorSchema, selectionBackground: hexColorSchema, selectionForeground: hexColorSchema,
  black: hexColorSchema, red: hexColorSchema, green: hexColorSchema, yellow: hexColorSchema,
  blue: hexColorSchema, magenta: hexColorSchema, cyan: hexColorSchema, white: hexColorSchema,
  brightBlack: hexColorSchema, brightRed: hexColorSchema, brightGreen: hexColorSchema, brightYellow: hexColorSchema,
  brightBlue: hexColorSchema, brightMagenta: hexColorSchema, brightCyan: hexColorSchema, brightWhite: hexColorSchema,
  fontFamily: safeFontFamilySchema, fontSize: z.number().int().min(10).max(24),
  lineHeight: z.number().min(1).max(2), cursorStyle: z.enum(['block', 'bar', 'underline']),
  cursorBlink: z.boolean(), scrollback: z.number().int().min(500).max(20_000)
}).strict();
~~~

- [ ] **Step 4: Verify GREEN.**

Run: npm test -- --run tests/unit/shared/terminal-appearance.test.ts
Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add src/shared/terminal-appearance.ts src/shared/validation.ts tests/unit/shared/terminal-appearance.test.ts
git commit -m "feat: add terminal appearance profile model"
~~~

### Task 2: Persistent profiles, defaults and Host assignments

**Files:**
- Modify: src/server/db/migrations.ts, src/server/db/types.ts, src/server/db/repositories.ts, src/shared/validation.ts
- Create: src/server/terminal/terminal-profile-service.ts
- Test: tests/unit/server/migrations.test.ts, tests/unit/server/terminal-profile-service.test.ts

**Produces:** terminal_profiles, terminal_preferences, nullable hosts.terminal_profile_id, TerminalProfileService.

- [ ] **Step 1: Write the failing migration/service tests.**

~~~ts
expect(service.getDefault('default').id).toBe('builtin:midnight');
await service.create('default', { id: 'profile-ops', name: 'Ops', appearance: appearance() });
await service.setDefault('default', 'profile-ops');
await expect(service.delete('default', 'profile-ops')).rejects.toMatchObject({ code: 'TERMINAL_PROFILE_IN_USE' });
~~~

- [ ] **Step 2: Verify RED.**

Run: npm test -- --run tests/unit/server/migrations.test.ts tests/unit/server/terminal-profile-service.test.ts
Expected: table/service absent.

- [ ] **Step 3: Implement migration and repository/service methods.**

Create terminal_profiles(id, owner_id, name, appearance_json, created_at, updated_at) and terminal_preferences(owner_id, default_profile_id, created_at, updated_at); add nullable hosts.terminal_profile_id. Ensure getDefault creates builtin:midnight preference idempotently. Service permits built-ins, verifies custom ownership, and blocks deletion when default or assigned by a Host.

- [ ] **Step 4: Verify GREEN.**

Run: npm test -- --run tests/unit/server/migrations.test.ts tests/unit/server/terminal-profile-service.test.ts
Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/terminal/terminal-profile-service.ts src/shared/validation.ts tests/unit/server/migrations.test.ts tests/unit/server/terminal-profile-service.test.ts
git commit -m "feat: persist terminal appearance profiles"
~~~

### Task 3: Profile routes and Host validation

**Files:**
- Create: src/server/api/terminal-profile-routes.ts
- Modify: src/server/app.ts, src/server/api/host-routes.ts, src/server/api/route-helpers.ts
- Test: tests/integration/server/terminal-profile-routes.test.ts, tests/integration/server/host-routes.test.ts

**Produces:** GET/POST/PATCH/DELETE /api/terminal-profiles and GET/PATCH /api/terminal-preferences; Host terminalProfileId DTO and validation.

- [ ] **Step 1: Write the failing route test.**

~~~ts
const created = await app.inject({ method: 'POST', url: '/api/terminal-profiles', headers: { cookie }, payload: { name: 'Ops', appearance: appearance() } });
expect(created.statusCode).toBe(201);
const host = await app.inject({ method: 'PATCH', url: '/api/hosts/' + hostId, headers: { cookie }, payload: { terminalProfileId: created.json().id } });
expect(host.json().terminalProfileId).toBe(created.json().id);
~~~

- [ ] **Step 2: Verify RED.**

Run: npm test -- --run tests/integration/server/terminal-profile-routes.test.ts tests/integration/server/host-routes.test.ts
Expected: 404 and missing Host property.

- [ ] **Step 3: Implement unlocked-session routes and assignment checks.**

All routes call requireUnlockedSession. Host create/patch calls validateAssignment before writing. Only a null ID, built-in ID, or same-owner custom ID is valid. Profile and Host mutations schedule sync through the existing coordinator.

- [ ] **Step 4: Verify GREEN.**

Run: npm test -- --run tests/integration/server/terminal-profile-routes.test.ts tests/integration/server/host-routes.test.ts
Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add src/server/api/terminal-profile-routes.ts src/server/app.ts src/server/api/host-routes.ts src/server/api/route-helpers.ts tests/integration/server/terminal-profile-routes.test.ts tests/integration/server/host-routes.test.ts
git commit -m "feat: expose terminal profile assignments"
~~~

### Task 4: Encrypted bundle and sync round trip

**Files:**
- Modify: src/server/workspace/vault-bundle-service.ts, src/server/sync/sync-snapshot.ts, src/shared/import/types.ts
- Test: tests/unit/server/vault-bundle.test.ts, tests/integration/server/sync-routes.test.ts

**Produces:** terminalProfiles and terminalPreferences in exported payloads and snapshots.

- [ ] **Step 1: Write compatibility tests.**

~~~ts
expect(parsePayload(legacyPayload)).toMatchObject({ terminalProfiles: [], terminalPreferences: { defaultProfileId: 'builtin:midnight' } });
expect(await bundleService.createPayload(key)).toMatchObject({ terminalProfiles: [expect.objectContaining({ id: 'profile-ops' })] });
expect(restoredHost.terminalProfileId).toBe('profile-ops');
~~~

- [ ] **Step 2: Verify RED.**

Run: npm test -- --run tests/unit/server/vault-bundle.test.ts tests/integration/server/sync-routes.test.ts
Expected: profile payload fields absent.

- [ ] **Step 3: Implement versioned payload and transactional import.**

Keep old envelope parsing. Legacy plaintext creates empty profiles/default Midnight. New payload validation accepts profile/default fields, remaps custom profile name conflicts to "<name> (imported N)", rewrites incoming Host IDs to the remapped ID, and writes profiles/default/Hosts in the existing transaction. Sync snapshot creates, validates, previews and applies the same fields.

- [ ] **Step 4: Verify GREEN.**

Run: npm test -- --run tests/unit/server/vault-bundle.test.ts tests/integration/server/sync-routes.test.ts
Expected: PASS with legacy and sync round-trip coverage.

- [ ] **Step 5: Commit.**

~~~bash
git add src/server/workspace/vault-bundle-service.ts src/server/sync/sync-snapshot.ts src/shared/import/types.ts tests/unit/server/vault-bundle.test.ts tests/integration/server/sync-routes.test.ts
git commit -m "feat: sync terminal appearance profiles"
~~~

### Task 5: Web management, Host selector and live xterm updates

**Files:**
- Create: src/web/components/TerminalProfileManager.tsx, src/web/components/TerminalProfileEditor.tsx
- Modify: src/web/api.ts, src/web/platform/web-adapters.ts, src/web/App.tsx, src/web/components/HostForm.tsx, src/web/components/TerminalWorkspace.tsx, src/web/components/TerminalPanel.tsx, src/web/theme.ts, src/web/styles.css
- Test: tests/unit/web/terminal-profile-manager.dom.test.tsx, tests/unit/web/host-form.dom.test.tsx, tests/unit/web/terminal-panel.dom.test.tsx, tests/unit/web/api.test.ts

**Produces:** settings profile manager, inheritance/override selector, and hot-applied TerminalAppearance.

- [ ] **Step 1: Write failing DOM tests.**

~~~tsx
await user.click(screen.getByRole('button', { name: '新建终端外观' }));
await user.type(screen.getByLabelText('配置名称'), 'Ops');
await user.click(screen.getByRole('button', { name: '保存终端外观' }));
expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ops' }));
rerender(<TerminalPanel {...props} appearance={{ ...appearance(), fontSize: 16, cursorStyle: 'bar' }} />);
expect(testState.terminalInstances).toHaveLength(1);
expect(testState.terminalInstances[0].options.cursorStyle).toBe('bar');
~~~

- [ ] **Step 2: Verify RED.**

Run: npm test -- --run tests/unit/web/terminal-profile-manager.dom.test.tsx tests/unit/web/host-form.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/api.test.ts
Expected: controls, port parsing and appearance prop absent.

- [ ] **Step 3: Implement UI and xterm option updates.**

Load profiles/default after unlock and after bundle/sync apply. Settings separates Application appearance from Terminal appearance and opens manager. Editor uses input type=color for colors and controlled typography/cursor fields. Host form sends null for inheritance. Resolve Host profile in App/Workspace. TerminalPanel constructs and updates xterm.options with a fresh converted theme object, font family/size, line height, cursor style/blink and scrollback; refit without disposing the terminal.

- [ ] **Step 4: Verify GREEN.**

Run: npm test -- --run tests/unit/web/terminal-profile-manager.dom.test.tsx tests/unit/web/host-form.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/api.test.ts
Expected: PASS and exactly one terminal instance after a profile update.

- [ ] **Step 5: Commit.**

~~~bash
git add src/web/api.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/components/HostForm.tsx src/web/components/TerminalWorkspace.tsx src/web/components/TerminalPanel.tsx src/web/components/TerminalProfileManager.tsx src/web/components/TerminalProfileEditor.tsx src/web/theme.ts src/web/styles.css tests/unit/web/terminal-profile-manager.dom.test.tsx tests/unit/web/host-form.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/api.test.ts
git commit -m "feat: manage terminal appearance profiles"
~~~

### Task 6: Documentation and release verification

**Files:**
- Modify: README.md

- [ ] **Step 1: Document inheritance and browser font limitations.**

State that custom terminal profiles are encrypted Vault data, browser-installed fonts are required, inheritance is the default, and in-use profiles cannot be deleted.

- [ ] **Step 2: Run full verification.**

~~~bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
git status --short
~~~

Expected: zero test failures/type/lint errors, successful web/server build, no unrelated files staged.

- [ ] **Step 3: Commit the final documentation.**

~~~bash
git add README.md
git commit -m "docs: explain terminal appearance profiles"
~~~

## Plan self-review

- Every approved requirement maps to a task: model/persistence (1–2), API/Host assignment (3), encrypted bundle/sync (4), settings/Host/xterm behavior (5), and release proof (6).
- Names are consistent across tasks: TerminalAppearance, TerminalProfile, terminalProfileId, defaultProfileId.
- No placeholders remain; every implementation task has RED, GREEN and a scoped commit command.
