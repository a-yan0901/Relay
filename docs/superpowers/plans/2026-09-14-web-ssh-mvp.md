# Web SSH MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Docker Web SSH workspace that stores multiple Server configurations and gives the user a Termius-style host list, one-click interactive SSH terminals, safe host-key verification, and reliable short-disconnect recovery.

**Architecture:** Use one TypeScript repository containing a React/Vite browser UI and a Fastify Node.js service. The service owns SQLite persistence, an instance-level encrypted Vault, HTTP APIs, a WebSocket terminal gateway, and an injected SSH adapter backed by `ssh2`; the browser renders remote PTY bytes with xterm.js. Keep the boundaries explicit so the SSH session manager can become a separate worker without changing the UI or protocol later.

**Tech Stack:** Node.js 22+, TypeScript, React, Vite, Fastify, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, `@fastify/websocket`, `ssh2`, `argon2`, `better-sqlite3`, `zod`, `pino`, `@xterm/xterm`, xterm addons, Vitest, React Testing Library, Playwright, `tsup`, Docker Compose, and an OpenSSH integration fixture.

**Spec:** `docs/superpowers/specs/2026-09-14-web-ssh-design.md`

## Global Constraints

- 首发部署是单个 Docker 实例和一个 `/data` 数据卷，不依赖云端服务、Redis 或 Postgres。
- 首发是单 Vault/单用户体验；数据模型和 repository 方法必须保留未来 `owner_id`/tenant 边界。
- Server 配置必须支持 IP/域名、端口默认 22、用户名、密码认证和私钥认证（含可选 passphrase）。
- 主密码不落库；随机 Vault key 使用 Argon2id 派生的 KEK 包裹；主机凭据使用 AES-256-GCM 密文保存。
- SSH host key 首次连接必须由用户确认；已知指纹变化必须硬失败，不能添加无条件跳过校验的路径。
- 生产 WebSocket 只能通过 WSS；握手校验显式 Origin allowlist、HttpOnly session 和连接限制。
- 日志只能记录脱敏事件，不得记录终端内容、完整 WebSocket 消息、密码、私钥、passphrase、cookie 或 token。
- 浏览器使用 xterm.js 渲染终端数据；终端输出必须按不可信数据处理，不得通过 `innerHTML` 注入 DOM。
- 每个生产函数/方法先有一个能正确失败的测试，再写最小实现；每个任务都运行自己的测试和相关全套测试。
- 所有源码、测试、配置和文档使用英文标识符，用户界面文案使用简体中文。

---

## File Map

The implementation starts from the current documentation-only repository. The following boundaries are created before feature work:

~~~text
package.json                         scripts and dependency contract
tsconfig.json                        shared/browser TypeScript settings
tsconfig.server.json                 Node server compiler settings
vite.config.ts                       browser build and dev proxy
vitest.config.ts                     unit/API test environments
playwright.config.ts                 browser E2E configuration
eslint.config.js                     strict TypeScript/React lint configuration
index.html                           browser entry HTML
src/shared/validation.ts             request/domain schemas and inferred types
src/shared/protocol.ts               terminal WebSocket wire types and guards
src/shared/errors.ts                 stable application error codes
src/server/config.ts                 environment parsing with safe defaults
src/server/db/*.ts                   SQLite connection, migrations, repositories
src/server/vault/*.ts                KDF, envelope encryption, Vault service
src/server/auth/*.ts                 in-memory unlock sessions and cookies
src/server/ssh/*.ts                  SSH adapter, host-key policy, sessions
src/server/api/*.ts                  Fastify route registration
src/server/ws/*.ts                   WebSocket terminal gateway
src/server/app.ts                    dependency-injected Fastify app factory
src/server/index.ts                  production entry and static serving (initially empty)
src/web/*.tsx                        React app and page-level state
src/web/components/*.tsx             focused UI components
src/web/hooks/*.ts                   terminal and API hooks
src/web/styles.css                   design tokens and responsive layout
tests/unit/**/*.test.ts              pure domain/server/browser tests
tests/integration/**/*.test.ts       Fastify, WebSocket and OpenSSH tests
tests/e2e/**/*.spec.ts               Playwright user flows
tests/fixtures/openssh/*             reproducible SSH target for tests
Dockerfile                            multi-stage production image
docker-compose.yml                    local and integration services
README.md                             deployment and security instructions
~~~

## Task 1: Bootstrap the TypeScript application and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `eslint.config.js`
- Create: `index.html`
- Create: `src/web/main.tsx`
- Create: `src/server/index.ts`
- Create: `tests/unit/smoke.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces `npm run dev`, `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run test:e2e` scripts used by every later task.
- Produces a Vitest environment that can run Node tests under `tests/unit/server` and jsdom tests under `tests/unit/web`.

- [ ] **Step 1: Verify the execution workspace before creating feature files.**

Run:

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
BRANCH=$(git branch --show-current)
printf 'git_dir=%s\\ngit_common=%s\\nbranch=%s\\n' "$GIT_DIR" "$GIT_COMMON" "$BRANCH"
~~~

If this is the normal checkout, create an ignored `.worktrees/` directory and a branch named `feat/web-ssh-mvp`, then perform all implementation work in that linked worktree. Do not create a second worktree if the harness already placed the session in one.

- [ ] **Step 2: Create the package manifest and scripts.**

The manifest must expose these scripts:

~~~json
{
  "scripts": {
    "dev": "concurrently -k \\"vite --host 0.0.0.0\\" \\"tsx src/server/index.ts\\"",
    "build:web": "vite build --outDir dist/web",
    "build:server": "tsup src/server/index.ts --format esm --target node22 --out-dir dist/server --sourcemap --clean",
    "build": "npm run build:web && npm run build:server",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit"
  }
}
~~~

Add `"type": "module"` and runtime dependencies `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, `@fastify/websocket`, `argon2`, `better-sqlite3`, `fastify`, `pino`, `react`, `react-dom`, `ssh2`, `zod`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-web-links`, and `@xterm/xterm`. Add development dependencies `@eslint/js`, `@playwright/test`, `@testing-library/jest-dom`, `@testing-library/react`, `@testing-library/user-event`, `@types/better-sqlite3`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/ssh2`, `@vitejs/plugin-react`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `concurrently`, `eslint`, `globals`, `jsdom`, `tsup`, `tsx`, `typescript`, and `vitest`.

- [ ] **Step 3: Add compiler, Vite, test, and ignore configuration.**

Configure the browser TypeScript project with strict mode, JSX `react-jsx`, ES2022, and `noEmit`; configure the server project with strict mode, Node ESM resolution, and only `src/server/**/*.ts` plus `src/shared/**/*.ts` for no-emit typechecking. Use `tsup` to bundle `src/server/index.ts` to `dist/server/index.js`. Configure Vite to use `@vitejs/plugin-react`, resolve `@shared` to `src/shared`, and proxy `/api` and `/ws` to `http://localhost:3000` during development. Configure Vitest with `src` aliases, Node as the default environment, and `// @vitest-environment jsdom` at the top of browser DOM tests; configure Playwright to start the built server on port 4173. Configure `eslint.config.js` with `@eslint/js`, the TypeScript parser/plugin, browser globals for `src/web`, Node globals for `src/server`, and a no-explicit-any error. Ignore `node_modules`, `dist`, `.env*`, `data`, `.tmp-smoke-data`, Playwright output, coverage, and `.worktrees`.

- [ ] **Step 4: Write the harness smoke test before application code.**

Create `src/server/index.ts` with only `export {};` so the server compiler has an input without introducing behavior, and create `tests/unit/smoke.test.ts`:

~~~ts
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs a basic assertion', () => {
    expect('web-ssh').toContain('ssh');
  });
});
~~~

- [ ] **Step 5: Run the baseline test and typecheck.**

Run `npm install`, then:

~~~bash
npm test -- tests/unit/smoke.test.ts
npm run typecheck
~~~

Expected: the smoke test passes and TypeScript exits 0 with no source files beyond the browser entry.

- [ ] **Step 6: Commit the bootstrap.**

~~~bash
git add package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts playwright.config.ts index.html src/web/main.tsx tests/unit/smoke.test.ts .gitignore
git commit -m "build: bootstrap web ssh application"
~~~

## Task 2: Add shared validation, domain types, and protocol guards

**Files:**
- Create: `src/shared/validation.ts`
- Create: `src/shared/protocol.ts`
- Create: `src/shared/errors.ts`
- Test: `tests/unit/shared/validation.test.ts`
- Test: `tests/unit/shared/protocol.test.ts`

**Interfaces:**
- Produces `HostMetadata`, `HostCredentialInput`, `HostCreateInput`, `GroupInput`, `TerminalOpenMessage`, `TerminalControlMessage`, `TerminalServerEvent`, and `AppErrorCode` types.
- Produces `parseHostCreateInput(input: unknown): HostCreateInput` and `parseTerminalClientMessage(input: unknown): TerminalClientMessage`.

- [ ] **Step 1: Write failing validation tests.**

Test the exact behaviors: default port 22; valid IPv4, IPv6 and hostname; rejection of URL/shell syntax, empty username, ports outside 1–65535, unknown auth type, empty password, oversized private key, and more than 20 tags. Assert that password/private-key values are preserved in the parsed object for immediate encryption but never included in metadata serialization.

- [ ] **Step 2: Run the focused tests to verify the expected failure.**

Run `npm test -- tests/unit/shared/validation.test.ts tests/unit/shared/protocol.test.ts`.

Expected: FAIL because the parser exports do not exist yet; no test may pass due to an accidental implementation.

- [ ] **Step 3: Implement the minimum schemas and error codes.**

Use Zod discriminated unions:

~~~ts
const credentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('password'), password: z.string().min(1).max(4096) }),
  z.object({
    type: z.literal('private_key'),
    privateKey: z.string().min(1).max(32768),
    passphrase: z.string().max(4096).optional()
  })
]);
~~~

Implement `isHostAddress` using `net.isIP(value)` or a hostname validator that rejects whitespace, `/`, `?`, `#`, backslash, and control characters. Keep loopback and private ranges allowed because the self-hosted gateway is expected to reach LAN Server addresses.

- [ ] **Step 4: Add protocol failure tests.**

Cover `open`, `resize`, `host-key-decision`, `input`, `ping`, and `close`; reject negative/zero rows or columns, unknown message types, a host-key decision whose fingerprint does not match the pending fingerprint, input frames above 64 KiB, and JSON nesting not represented by the protocol.

- [ ] **Step 5: Implement protocol types and guards.**

Define the wire union with explicit `type` fields. `parseTerminalClientMessage` must return a typed union or throw `AppError('PROTOCOL_INVALID_MESSAGE')`; the guard must not execute commands or interpret arbitrary fields.

- [ ] **Step 6: Run focused and full tests, then commit.**

~~~bash
npm test -- tests/unit/shared/validation.test.ts tests/unit/shared/protocol.test.ts
npm test
git add src/shared tests/unit/shared
git commit -m "feat: add shared host and terminal contracts"
~~~

## Task 3: Implement the encrypted Vault

**Files:**
- Create: `src/server/vault/crypto.ts`
- Create: `src/server/vault/vault-service.ts`
- Create: `src/server/vault/types.ts`
- Test: `tests/unit/server/vault.test.ts`

**Interfaces:**
- Produces `VaultService.create(masterPassword)`, `VaultService.unlock(masterPassword, config)`, `VaultService.encryptJson(key, aad, value)`, and `VaultService.decryptJson(key, aad, blob)`.
- `VaultConfig` contains only serializable KDF and wrapped-key fields; `Buffer` secrets do not cross the repository boundary except as ephemeral values.

- [ ] **Step 1: Write failing crypto tests.**

Cover: a newly created Vault can be unlocked with the same master password; a wrong master password fails; a host credential JSON round-trips; changing one ciphertext byte or AAD fails authentication; two encryptions of the same value have different nonces; the serialized config contains no master password or plaintext credential; Argon2id parameters are `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`, and `hashLength: 32`.

- [ ] **Step 2: Run the tests and confirm they fail for missing exports.**

Run `npm test -- tests/unit/server/vault.test.ts`; expected failure is missing `VaultService`, not a test syntax error.

- [ ] **Step 3: Implement Argon2id key derivation and AES-256-GCM.**

Use Node `crypto.randomBytes(16)` for salt, `randomBytes(12)` for GCM nonce, and the `argon2` package with `argon2id`, `raw: true`, and a 32-byte output. Store ciphertext, tag, nonce, version, and AAD purpose as base64 strings. Reject wrong versions and invalid key lengths before decryption.

- [ ] **Step 4: Implement `VaultService`.**

Generate a random 32-byte Vault key, derive a KEK from the master password, encrypt the Vault key with AAD `vault-key:v1`, and return a serializable `VaultConfig` plus an ephemeral key. `unlock` only returns a key after GCM authentication succeeds.

- [ ] **Step 5: Run focused tests, typecheck, and commit.**

~~~bash
npm test -- tests/unit/server/vault.test.ts
npm run typecheck
git add src/server/vault tests/unit/server/vault.test.ts
git commit -m "feat: encrypt vault credentials at rest"
~~~

## Task 4: Add SQLite migrations and repositories

**Files:**
- Create: `src/server/db/database.ts`
- Create: `src/server/db/migrations.ts`
- Create: `src/server/db/types.ts`
- Create: `src/server/db/repositories.ts`
- Test: `tests/unit/server/repositories.test.ts`

**Interfaces:**
- Produces `openDatabase(filename)`, `migrate(db)`, `AppConfigRepository`, `HostRepository`, `GroupRepository`, and `AuditRepository`.
- `HostRepository.listMetadata` returns only `HostMetadata`; credential ciphertext is available only to `getForConnection(id)` after the caller has an unlocked session.

- [ ] **Step 1: Write repository tests first.**

Use an in-memory SQLite database. Test migration creation, host create/list/update/delete, group membership, tag and favorite fields, recent-connection update, and audit event insertion. Assert that the metadata method has no `credentialCiphertext` property and that deleting a host removes its encrypted credential and fingerprint.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run `npm test -- tests/unit/server/repositories.test.ts`; expected failure is missing database/repository exports.

- [ ] **Step 3: Implement migrations.**

Create the four tables from the design: `app_config`, `groups`, `hosts`, and `audit_events`, with foreign keys enabled, unique group names per `owner_id`, UUID text IDs, ISO timestamps, and indexes for owner/name/address/recent connection. Add `owner_id TEXT NOT NULL DEFAULT 'default'` to groups, hosts, and audit events so the single-user release has an explicit future tenant boundary. Store encrypted values as JSON text or BLOB without parsing them in SQL.

- [ ] **Step 4: Implement repositories with prepared statements.**

Validate IDs at the domain layer, use parameterized queries for every value, and make host deletion transactional. Every list/get/update/delete query must filter by an explicit owner id, defaulting only at the single-user composition root to `default`. Provide explicit methods:

~~~ts
createHost(input: HostRow): HostRow;
updateHost(id: string, patch: HostPatch): HostRow;
listMetadata(filter: HostFilter): HostMetadata[];
getForConnection(id: string): HostConnectionRecord | null;
deleteHost(id: string): void;
~~~

- [ ] **Step 5: Run focused/all tests and commit.**

~~~bash
npm test -- tests/unit/server/repositories.test.ts
npm test
git add src/server/db tests/unit/server/repositories.test.ts
git commit -m "feat: persist hosts groups and audit events"
~~~

## Task 5: Add setup, unlock sessions, and Fastify app factory

**Files:**
- Create: `src/server/auth/session-store.ts`
- Create: `src/server/auth/session-cookie.ts`
- Create: `src/server/ssh/types.ts`
- Create: `src/server/api/setup-routes.ts`
- Create: `src/server/app.ts`
- Test: `tests/integration/server/auth-routes.test.ts`
- Test: `tests/unit/server/session-store.test.ts`

**Interfaces:**
- Produces `SessionStore.create(vaultKey)`, `get(id)`, `revoke(id)`, `revokeAll()`, and `sweep(now)`.
- `src/server/ssh/types.ts` defines the injected `SshAdapterPort`, `SshSessionManagerPort`, and `SshChannel` interfaces used by the app factory and host API before the concrete adapter exists.
- Produces `buildApp(dependencies)` where dependencies include database repositories, `VaultService`, `SessionStore`, `SshSessionManager`, and parsed config.

- [ ] **Step 1: Write failing session-store tests.**

Test random non-repeating IDs, retrieval before expiry, idle expiry, revoke clearing the key buffer, `revokeAll`, and sweep behavior. Assert that an expired session cannot be reused to read a Vault key.

- [ ] **Step 2: Run session tests and confirm the expected failure.**

Run `npm test -- tests/unit/server/session-store.test.ts`; expected failure is missing `SessionStore`.

- [ ] **Step 3: Implement in-memory session storage.**

Use `crypto.randomBytes(32).toString('base64url')` as the opaque ID. Store only the Vault key, creation time, last-used time and active connection count. Refresh last-used time on authenticated API requests and WebSocket frames; do not serialize Vault keys into cookies.

- [ ] **Step 4: Write failing Fastify auth tests.**

Use `app.inject` with a temporary in-memory database. Cover setup status, one-time setup, short/empty master password rejection, correct unlock setting an HttpOnly/SameSite cookie, wrong unlock returning a stable error, session status, lock revoking the cookie, and locked access returning 401.

- [ ] **Step 5: Implement the app factory and auth routes.**

Register `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, and `@fastify/websocket`. Use a cookie named `webssh_session`, `HttpOnly`, `SameSite=Strict`, and `Secure` when `NODE_ENV=production`. Add a request ID to all responses and redact cookie/auth headers in Pino serializers. Implement setup only when `app_config` is absent; no route may return KDF salts as secrets or return the Vault key.

- [ ] **Step 6: Run focused/full tests and commit.**

~~~bash
npm test -- tests/unit/server/session-store.test.ts tests/integration/server/auth-routes.test.ts
npm test
git add src/server/auth src/server/api/setup-routes.ts src/server/app.ts tests/unit/server/session-store.test.ts tests/integration/server/auth-routes.test.ts
git commit -m "feat: add vault setup and unlock sessions"
~~~

## Task 6: Implement host and group APIs

**Files:**
- Create: `src/server/api/host-routes.ts`
- Create: `src/server/api/group-routes.ts`
- Create: `src/server/api/route-helpers.ts`
- Test: `tests/integration/server/host-routes.test.ts`
- Test: `tests/integration/server/group-routes.test.ts`

**Interfaces:**
- Produces REST routes from the specification under `/api/hosts` and `/api/groups`.
- Produces `requireUnlockedSession(request)` and `toHostMetadataDto(row)` helpers.

- [ ] **Step 1: Write failing host API tests.**

After setup/unlock, test create with password, create with private key, default port, metadata response redaction, list search/group/favorite filters, patch replacing credentials, delete, invalid host values, no-session access, and unknown host IDs. Add a test that scans the serialized response and Pino test records for the submitted password/private key.

- [ ] **Step 2: Run the tests and verify expected missing-route failures.**

Run `npm test -- tests/integration/server/host-routes.test.ts tests/integration/server/group-routes.test.ts`; expected failure is 404 or missing route registration, not a database setup error.

- [ ] **Step 3: Implement group routes.**

Provide create/list/patch/delete with name length 1–80, duplicate name rejection, safe ordering, and host reassignment protection. Deleting a group sets `group_id` to null rather than deleting hosts.

- [ ] **Step 4: Implement host routes.**

For create/patch, require an unlocked session, parse the shared schema, encrypt only the credential union with `VaultService.encryptJson`, store the metadata and ciphertext in one transaction, and return a DTO without secret fields. For list, apply query filters through prepared statements. `test-connection` delegates to `SshSessionManager.testConnection` and returns either success or a host-key challenge without storing a new fingerprint.

- [ ] **Step 5: Run focused/full tests and commit.**

~~~bash
npm test -- tests/integration/server/host-routes.test.ts tests/integration/server/group-routes.test.ts
npm test
git add src/server/api/host-routes.ts src/server/api/group-routes.ts src/server/api/route-helpers.ts tests/integration/server
git commit -m "feat: add host and group management APIs"
~~~

## Task 7: Implement SSH adapter, host-key policy, and session manager

**Files:**
- Modify: `src/server/ssh/types.ts`
- Create: `src/server/ssh/host-key-policy.ts`
- Create: `src/server/ssh/ssh2-adapter.ts`
- Create: `src/server/ssh/session-manager.ts`
- Test: `tests/unit/server/host-key-policy.test.ts`
- Test: `tests/unit/server/ssh2-adapter.test.ts`
- Test: `tests/unit/server/session-manager.test.ts`

**Interfaces:**
- Produces `SshAdapter.connect(config, callbacks): Promise<SshChannel>` and `SshSessionManager.open`, `testConnection`, `detach`, `reattach`, `close`.
- `SshChannel` exposes `write(data)`, `resize(cols, rows)`, `close()`, and events `data`, `stderr`, `exit`, `close`, `error`.

- [ ] **Step 1: Write host-key policy tests.**

Cover unknown fingerprint challenge, matching fingerprint acceptance, mismatch rejection, user trust persisting the fingerprint only after the decision, and a rejected decision never mutating the repository. Use a deterministic `SHA256:` fixture and assert algorithm/address are returned to the UI.

- [ ] **Step 2: Run the policy tests and verify they fail.**

Run `npm test -- tests/unit/server/host-key-policy.test.ts`; expected failure is absent policy implementation.

- [ ] **Step 3: Implement host-key policy.**

Use `ssh2` `hostHash: 'sha256'` and the asynchronous `hostVerifier(key, callback)` form. The policy must call `callback(false)` for a known mismatch, pause with a pending decision for an unknown key, and call `callback(true)` only after a matching `host-key-decision` arrives. Store the fingerprint only after the decision and only for the same host/session.

- [ ] **Step 4: Write adapter tests with an injected client factory.**

Test conversion of password and private-key credentials into `ssh2` options, default port, keepalive settings, PTY rows/cols, callback error mapping, and close cleanup. The test factory must record options without logging credential values; this is the one boundary where a fake dependency is necessary to exercise library integration deterministically.

- [ ] **Step 5: Implement the `ssh2` adapter.**

Create a `Client`, pass `readyTimeout`, `keepaliveInterval`, `keepaliveCountMax`, `hostHash`, and `hostVerifier`, then call `client.shell({ term: 'xterm-256color', cols, rows, width: 0, height: 0 }, ...)`. Map channel `data` to buffers, ignore/route stderr separately, and ensure `end()` is idempotent.

- [ ] **Step 6: Write and implement session-manager tests.**

Test one session per terminal tab, connection limits, 30-second WebSocket detach retention, successful reattach by session ID, expiry cleanup, close releasing the SSH channel, and no session reuse after lock. Use the fake adapter and assert `close()` exactly once.

- [ ] **Step 7: Run focused/full tests and commit.**

~~~bash
npm test -- tests/unit/server/host-key-policy.test.ts tests/unit/server/ssh2-adapter.test.ts tests/unit/server/session-manager.test.ts
npm test
git add src/server/ssh tests/unit/server
git commit -m "feat: bridge interactive ssh sessions"
~~~

## Task 8: Add the authenticated terminal WebSocket gateway

**Files:**
- Create: `src/server/ws/terminal-gateway.ts`
- Modify: `src/server/app.ts`
- Test: `tests/integration/server/terminal-gateway.test.ts`
- Test: `tests/unit/server/terminal-gateway-state.test.ts`

**Interfaces:**
- Produces `registerTerminalGateway(app, dependencies)` and a WebSocket endpoint at `/ws/terminal`.
- Uses the shared terminal protocol without changing its wire field names.

- [ ] **Step 1: Write failing state/protocol integration tests.**

Start an app on an ephemeral port and connect with `ws`. Test rejection for missing cookie, expired session, wrong Origin, invalid JSON, oversized input, and unknown host ID. Test the happy sequence `open → connecting → connected → binary output`, resize forwarding, close, and server error mapping.

- [ ] **Step 2: Run focused tests and verify expected handshake failures.**

Run `npm test -- tests/integration/server/terminal-gateway.test.ts tests/unit/server/terminal-gateway-state.test.ts`; expected failures are missing endpoint/registration.

- [ ] **Step 3: Implement handshake validation and connection binding.**

Validate the request Origin against `TRUSTED_ORIGINS` before accepting the upgrade, look up the HttpOnly session, and bind one WebSocket to one session/terminal ID. Reject a second `open` on the same socket and all frames after `closed`.

- [ ] **Step 4: Implement the message loop.**

Parse every text/control frame with `parseTerminalClientMessage`; enforce a 64 KiB input limit and a bounded JSON frame size. Forward binary/text input only to the channel, forward `resize` to `channel.resize`, and route host-key challenge/decision through `HostKeyPolicy`. Send `status`, `host-key`, `error`, `exit`, and `closed` events; never include credentials or raw errors.

- [ ] **Step 5: Implement detach/reattach and cleanup.**

On abnormal socket close, call `sessionManager.detach` and preserve only the SSH session for the configured 30-second window. On explicit close, logout, expiry or lock, close the WebSocket and SSH channel immediately. Register `close` handlers so every listener and timer is removed exactly once.

- [ ] **Step 6: Run tests and commit.**

~~~bash
npm test -- tests/integration/server/terminal-gateway.test.ts tests/unit/server/terminal-gateway-state.test.ts
npm test
git add src/server/ws src/server/app.ts tests/integration/server/terminal-gateway.test.ts tests/unit/server/terminal-gateway-state.test.ts
git commit -m "feat: add secure terminal websocket gateway"
~~~

## Task 9: Build the Termius-style browser shell and host management UI

**Files:**
- Create: `src/web/App.tsx`
- Create: `src/web/api.ts`
- Create: `src/web/state/app-state.ts`
- Create: `src/web/components/SetupGate.tsx`
- Create: `src/web/components/UnlockView.tsx`
- Create: `src/web/components/HostWorkspace.tsx`
- Create: `src/web/components/HostList.tsx`
- Create: `src/web/components/HostCard.tsx`
- Create: `src/web/components/HostForm.tsx`
- Create: `src/web/components/GroupSidebar.tsx`
- Create: `src/web/components/ConnectionStatus.tsx`
- Create: `src/web/styles.css`
- Modify: `src/web/main.tsx`
- Test: `tests/unit/web/app-state.test.ts`
- Test: `tests/unit/web/host-form.dom.test.tsx`
- Test: `tests/unit/web/host-workspace.dom.test.tsx`

**Interfaces:**
- `api.ts` exposes typed `getSetupStatus`, `setupVault`, `unlockVault`, `lockVault`, `listHosts`, `createHost`, `updateHost`, `deleteHost`, `listGroups`, and `testConnection` functions.
- `app-state.ts` exposes a reducer with `setup`, `unlock`, `lock`, `hostsLoaded`, `hostCreated`, `hostUpdated`, `hostDeleted`, `groupSelected`, and `terminalOpened` actions.

- [ ] **Step 1: Write failing state tests.**

Test initial setup/locked/unlocked states, host list replacement, optimistic favorite update rollback on API failure, selected group/query filters, and multiple terminal tab IDs. Assert no action payload can store password or private key in the host metadata state.

- [ ] **Step 2: Run state tests and verify they fail.**

Run `npm test -- tests/unit/web/app-state.test.ts`; expected failure is missing reducer/state exports.

- [ ] **Step 3: Implement typed API client and state reducer.**

Use `fetch` with `credentials: 'same-origin'`, parse JSON errors into `AppError`, and keep credentials only in the controlled form submission. After create/update, clear password/private-key form state and reload metadata.

- [ ] **Step 4: Write failing form/workspace tests.**

With React Testing Library and `user-event`, test rendering the required Server fields, port default 22, switching password/private-key fields, validation messages, submitting a host without exposing secret values in list text, searching by IP/name/user/tag, favorite toggle, group filter, and empty-state “添加第一台 Server” action.

- [ ] **Step 5: Implement the host workspace UI.**

Create a three-area responsive layout: sidebar for navigation/groups, host list/cards in the center, and terminal workspace as the primary content when a tab is active. Use the design tokens from the product document: deep navy background, neutral panels, blue accent, green connected state, red dangerous state. Use semantic buttons, visible focus rings, labels, and keyboard navigation.

- [ ] **Step 6: Run UI tests and commit.**

~~~bash
npm test -- tests/unit/web/app-state.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
npm run typecheck
git add src/web tests/unit/web
git commit -m "feat: add host workspace interface"
~~~

## Task 10: Integrate xterm.js terminal tabs and reconnect UX

**Files:**
- Create: `src/web/hooks/use-terminal-session.ts`
- Create: `src/web/components/TerminalWorkspace.tsx`
- Create: `src/web/components/TerminalPanel.tsx`
- Create: `src/web/components/TerminalToolbar.tsx`
- Create: `src/web/components/HostKeyDialog.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/state/app-state.ts`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/terminal-session.test.ts`
- Test: `tests/unit/web/terminal-workspace.dom.test.tsx`

**Interfaces:**
- `useTerminalSession({ hostId, terminalId })` returns `{ state, connect, reconnect, sendInput, resize, close }`.
- `TerminalPanel` accepts `{ terminalId, host, active, onClose }` and owns exactly one xterm.js `Terminal` instance per tab.

- [ ] **Step 1: Write failing terminal controller tests.**

Inject a fake WebSocket and fake terminal factory. Test open message fields, binary output forwarding to `terminal.write`, input forwarding, resize forwarding after `FitAddon.fit`, host-key dialog state, close cleanup, reconnect backoff capped at 5 seconds, and terminal status transitions.

- [ ] **Step 2: Run focused tests and verify failure.**

Run `npm test -- tests/unit/web/terminal-session.test.ts`; expected failure is missing hook/controller implementation.

- [ ] **Step 3: Implement the WebSocket session hook.**

Construct the same-origin `wss` or `ws` URL from `window.location`, send `open` only after `onopen`, send raw input as binary/UTF-8 frames, decode server JSON control events separately from binary output, and never log frame contents. Use exponential backoff for unintentional closes while the tab remains mounted.

- [ ] **Step 4: Write failing terminal workspace tests.**

Test multiple tabs, active-tab switching without unmounting inactive terminals, toolbar reconnect/close actions, host-key prompt requiring explicit Trust/Reject, host-key mismatch red state, and responsive terminal container resize.

- [ ] **Step 5: Implement xterm.js terminal components.**

Load `FitAddon`, `SearchAddon`, and `WebLinksAddon`; call `fitAddon.fit()` after mount and via `ResizeObserver`; set `term: xterm-256color` through the server open message; render host-key data in a modal with algorithm/fingerprint/address; never use `innerHTML` for terminal data or link labels.

- [ ] **Step 6: Run UI/full tests and commit.**

~~~bash
npm test -- tests/unit/web/terminal-session.test.ts tests/unit/web/terminal-workspace.dom.test.tsx
npm test
npm run typecheck
git add src/web tests/unit/web
git commit -m "feat: add interactive terminal workspace"
~~~

## Task 11: Add production entrypoint, configuration, Docker, and deployment docs

**Files:**
- Create: `src/server/config.ts`
- Modify: `src/server/index.ts`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `README.md`
- Test: `tests/unit/server/config.test.ts`
- Test: `tests/integration/server/health.test.ts`

**Interfaces:**
- Produces `loadConfig(env)` with safe defaults and explicit validation for origins, limits, port and data directory.
- Produces `/healthz` and `/api/version` endpoints without sensitive configuration.

- [ ] **Step 1: Write failing configuration and health tests.**

Test default port/data directory/session timeout/max sessions, production rejection of an empty trusted-origin list, invalid port, invalid timeout, health response shape, and health response not including environment or database path.

- [ ] **Step 2: Run focused tests and verify missing implementation failure.**

Run `npm test -- tests/unit/server/config.test.ts tests/integration/server/health.test.ts`; expected failure is missing configuration/entrypoint exports.

- [ ] **Step 3: Implement configuration and production entrypoint.**

Parse `PORT`, `DATA_DIR`, `TRUSTED_ORIGINS`, `SESSION_IDLE_TIMEOUT`, `MAX_SESSIONS`, `LOG_LEVEL`, and `NODE_ENV`. Open the database, migrate it, create repositories/services, register routes and WebSocket gateway, serve `dist/web`, and close database/session resources on SIGTERM.

- [ ] **Step 4: Implement Docker packaging.**

Use a multi-stage Node 22 build image that installs dependencies and runs `npm run build`, then a runtime stage that copies only `dist`, production `node_modules`, and package metadata. Create a non-root `webssh` user, set `WORKDIR /app`, expose 3000, mount `/data`, and run `node dist/server/index.js`. Compose must include the app, a named `webssh_data` volume, and an optional `openssh-test` profile for integration tests.

- [ ] **Step 5: Write deployment/security documentation.**

Document Docker run/compose, reverse proxy HTTPS/WSS requirement, `TRUSTED_ORIGINS`, backup of `/data`, main-password loss behavior, container egress requirements, host-key behavior, threat model, and the fact that an attacker controlling a live unlocked container can access active credentials.

- [ ] **Step 6: Run build and Docker smoke tests, then commit.**

~~~bash
npm test -- tests/unit/server/config.test.ts tests/integration/server/health.test.ts
npm run lint
npm run typecheck
npm run build
docker build -t webssh:test .
docker run --rm -d --name webssh-smoke -p 3300:3000 -e NODE_ENV=production -e TRUSTED_ORIGINS=http://127.0.0.1:3300 -v "$(pwd)/.tmp-smoke-data:/data" webssh:test
curl --fail http://127.0.0.1:3300/healthz
docker stop webssh-smoke
git add src/server/config.ts src/server/index.ts Dockerfile docker-compose.yml .dockerignore README.md tests/unit/server/config.test.ts tests/integration/server/health.test.ts
git commit -m "build: package web ssh for docker"
~~~

## Task 12: Add a real OpenSSH fixture and end-to-end coverage

**Files:**
- Create: `tests/fixtures/openssh/Dockerfile`
- Create: `tests/fixtures/openssh/entrypoint.sh`
- Create: `tests/fixtures/openssh/sshd_config`
- Create: `tests/fixtures/openssh/authorized_keys`
- Create: `tests/fixtures/openssh/test_client_ed25519`
- Create: `tests/integration/openssh/ssh-fixture.test.ts`
- Create: `tests/e2e/host-to-terminal.spec.ts`
- Modify: `docker-compose.yml`
- Modify: `playwright.config.ts`

**Interfaces:**
- Produces a deterministic local SSH target with a known test password and an ED25519 test key, isolated to the Compose test network.
- Produces the final user journey test against the built Web SSH app, not against mocks.

- [ ] **Step 1: Create the fixture image and test credentials.**

Build a minimal OpenSSH server image from `debian:bookworm-slim`, install the distribution `openssh-server` package, create a non-root test user, read the fixture password from the Compose-only `WEBSSH_FIXTURE_PASSWORD` environment variable, enable password and public-key authentication only for the fixture, set `PermitRootLogin no`, expose 22, and generate host keys at container start. Store the matching client private key in `tests/fixtures/openssh/test_client_ed25519`; keep all fixture credentials inside test files and never reuse them in documentation.

- [ ] **Step 2: Write the failing SSH integration test.**

Start the fixture, connect through the real `Ssh2Adapter`, assert password login, private-key login, interactive `printf`, PTY resize observed by `stty size`, wrong credential failure, and host-key mismatch. Run it before wiring E2E; expected failure is missing fixture/adapter integration.

- [ ] **Step 3: Add the Compose integration profile.**

Expose the fixture only on the internal Compose network; use a dynamic internal hostname `ssh-fixture` and port 22. Do not publish the fixture port to the host unless the test runner requires it, and if it does, bind it to loopback only.

- [ ] **Step 4: Write the failing Playwright flow.**

The browser test must: initialize a fresh data directory, set a master password, add a fixture Server with IP/hostname, port, username and password, trust the displayed fingerprint, see a connected terminal, type `printf 'web-ssh-e2e\\\\n'`, observe the output, open a second host tab, search/filter the list, lock the Vault, and verify a new connection is blocked while locked.

- [ ] **Step 5: Configure and run E2E.**

Start the built app and SSH fixture with a test-only Compose profile, wait on `/healthz`, run `npx playwright test`, save traces only on failure, and tear down containers/data afterward. Ensure no production data directory is used by E2E.

- [ ] **Step 6: Commit integration coverage.**

~~~bash
npm test -- tests/integration/openssh/ssh-fixture.test.ts
npm run build
npm run test:e2e
git add tests/fixtures tests/integration/openssh tests/e2e docker-compose.yml playwright.config.ts
git commit -m "test: cover real ssh and browser workflows"
~~~

## Task 13: Run the complete security and release verification

**Files:**
- Modify: `README.md` only if verification exposes a documentation mismatch.
- Test: existing security-focused tests in `tests/unit`, `tests/integration`, and `tests/e2e`.

**Interfaces:**
- Produces a reproducible release checklist and a clean working tree with every required acceptance criterion evidenced by a command or test.

- [ ] **Step 1: Run the complete automated suite.**

~~~bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

Record exit codes and test counts; do not summarize a partial run as full verification.

- [ ] **Step 2: Run secret and artifact scans.**

Search tracked source, logs and build output for the known fixture password values, private-key PEM markers, hard-coded bearer/cookie values and terminal payloads. Property names such as `passphrase` are allowed; actual secret values are not. Verify that the only key material is inside controlled test fixtures and that production logging serializers redact auth headers.

- [ ] **Step 3: Run manual protocol/security checks.**

Use a WebSocket client to attempt an untrusted Origin, missing session, invalid control message, oversized input and host-key mismatch. Confirm each is rejected with a stable code and no secret appears in output. Use browser devtools once to confirm terminal output is carried over WSS in production configuration and no credential request is placed in a URL.

- [ ] **Step 4: Audit requirements against the spec.**

Check FR-001 through FR-014 and NFR-001 through NFR-007 individually against tests, build output, Docker smoke output and current source. A requirement without direct evidence remains incomplete and must be fixed before release.

- [ ] **Step 5: Run final verification and commit any documentation-only fixes.**

~~~bash
git diff --check
git status --short
git log --oneline --decorate -8
~~~

Only after all commands and the requirement checklist provide fresh evidence may the implementation be described as complete.
