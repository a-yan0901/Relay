# Relay 账号重新认证与删除恢复 Implementation Plan

> **REQUIRED SUB-SKILL:** Use `superpowers:executing-plans` to execute this plan task by task with review checkpoints.

## Goal

完成 X-04D：为 Relay 增加服务端验证、短时有效的重新认证，以及云端同步数据删除和完整账号删除的可恢复闭环。删除期间必须停止云端读写与后台上传；恢复、过期清理、设备撤销、本地副本保留均有明确的 API、UI、审计和自动化验证。

## Architecture and boundaries

- 账户重新认证状态绑定到当前服务端会话，服务端只保存短时有效的成功标记，绝不把客户端传入的 `reauthenticated: true` 当作授权依据，也不回传密码或 token。
- 云端同步数据删除继续使用 `sync_delete_requests`，保留账号和本地数据，进入 30 天可恢复窗口；完整账号删除新增 `account_delete_requests`，撤销全部设备和会话，保留 30 天可恢复窗口。
- 完整账号删除到期后只清理云端同步数据、云端账号元数据、设备和服务端会话；不删除本机 `app_config`、主机、身份、分组、工作区、命令、传输记录、审计历史，也不撤销本地 Vault 会话。
- 待删除账号只允许登录以进入恢复流程；待删除状态下所有同步读写、冲突操作、恢复密钥操作和后台上传都拒绝。同步状态接口可以返回“仅本地”与倒计时，帮助 UI 呈现恢复入口。
- 本计划不实现“退出账号并删除本地数据”；该动作继续作为独立的高风险本地清理能力，避免与云端账号删除混淆。

## Tech Stack and validation

- TypeScript、Zod、Fastify、SQLite migrations/repositories、React、Vitest、Playwright。
- 每个任务先补充会失败的测试，确认失败原因后实现最小改动，再运行任务级测试。
- X-04D 属于跨账户权限、数据库迁移、同步后台和 UI 的重大修改。全部任务完成后执行完整发布门禁：全量 Vitest、typecheck、lint、build、默认 E2E、账号启用 E2E、敏感数据扫描和 git diff/status 检查。
- 不改动用户已有的无关工作区变更；临时数据库和测试产物不得提交。

## References

- Design specification: `docs/superpowers/specs/2026-09-17-relay-account-deletion-design.md`
- Roadmap: `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`
- Existing sync contract: `src/shared/core/models.ts`, `src/shared/core/ports.ts`, `src/shared/core/account-sync.ts`, `src/server/sync/*`, `src/client/web/*`

## Task 1: Establish shared deletion and re-auth contracts

### Files

- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/core/ports.ts`
- Modify: `src/shared/core/account-sync.ts`
- Modify: `src/shared/errors.ts`
- Modify: `src/native/fakes/in-memory-account-api.ts` (or the repository’s equivalent native fake)
- Add/modify: shared contract tests near `src/shared/**/__tests__` and `tests/unit`

### Steps

1. Add exact confirmation constants for `DELETE MY ACCOUNT` and `DELETE MY CLOUD VAULT`; keep them separate so a cloud confirmation cannot authorize account deletion.
2. Add `AccountDeletionState` with request time, delete-after time, remaining time, and a deletion kind/status sufficient for the UI to distinguish account and cloud deletion without exposing secrets.
3. Extend account and sync ports with re-authentication, account deletion status/request/restore, and cloud deletion request/restore methods. Keep existing baseline capability negotiation compatible with clients that do not implement the optional methods.
4. Add stable error codes and status mappings for re-authentication failure/required, missing confirmation, deletion pending/not pending, and sync blocked during deletion.
5. Extend native fakes so unit tests can exercise the new flows without weakening production authorization.
6. Write tests for exact confirmation values, serialization shape, error mapping, and fake behavior. Run the focused shared tests and verify they fail before implementation, then make them pass.

### Acceptance

- No contract accepts a client-controlled boolean as proof of re-authentication.
- Account and cloud deletion confirmations are not interchangeable.
- New methods and error codes are typed, serializable, and backward-compatible at capability boundaries.

## Task 2: Implement session-bound re-authentication and schema/repository support

### Files

- Modify: `src/server/account/account-session-store.ts`
- Modify: `src/server/account/account-service.ts`
- Modify: `src/server/db/migrations.ts`
- Modify: `src/server/db/repositories.ts`
- Add/modify: account/session/repository unit tests

### Steps

1. Add a session-bound re-auth record keyed by the current server session, with a fixed 10-minute TTL, explicit expiry check, and invalidation on session revoke, device revoke, sign-out, and account revoke-all.
2. Expose service methods that verify the current account password server-side and mark the current session re-authenticated only after successful verification. Return only success or stable errors; never log or persist the password.
3. Add migration version 14 with `account_delete_requests` and the required indexes/constraints for one active request per account and efficient expiry lookup. Preserve existing migration behavior and test upgrade from the previous schema.
4. Add repository operations to create/read/restore/purge account deletion requests, revoke all account devices/sessions, and delete only cloud/account rows at expiry. Make expiry cleanup transactional and idempotent.
5. Add service startup/before-operation cleanup for expired account deletion requests. When an account is purged, revoke its in-memory sessions after the database transaction succeeds.
6. Test TTL boundaries, wrong password, session/device/account revocation invalidation, migration upgrade, idempotent expiry cleanup, and preservation of local owner tables and local Vault session state.

### Acceptance

- Re-auth cannot be forged by request JSON or copied between sessions.
- Re-auth is valid for at most 10 minutes and is invalid after the relevant session/device/account is revoked.
- Account deletion expiry removes cloud/account metadata but leaves local application data and local Vault session intact.

## Task 3: Add account deletion API and recovery lifecycle

### Files

- Modify: `src/server/account/account-service.ts`
- Modify: `src/server/http/account-routes.ts`
- Modify: `src/server/http/error-handler.ts` (only if stable error mapping requires it)
- Modify: account API integration tests

### Steps

1. Add `POST /api/account/session/reauth` with a strict `{password}` body, no-store response headers, generic failure behavior, rate limiting consistent with existing account auth, and no credential-bearing audit payload.
2. Add `GET /api/account/deletion` returning the current redacted deletion state or `null`.
3. Add `POST /api/account/deletion` requiring a current session, fresh server-side re-authentication, and exact `DELETE MY ACCOUNT` confirmation; create the pending request transactionally, revoke all devices/sessions, audit the redacted operation, and clear the current cookie only after success.
4. Add `POST /api/account/deletion/restore` requiring a valid session and fresh re-authentication. Restore the pending account request, preserve the intentional revoked-device result, issue/retain a valid current session as designed, and audit the result.
5. Permit password sign-in for a pending account only as a recovery path; prevent normal account/sync use until the deletion is restored. Ensure expired pending accounts cannot sign in.
6. Add integration tests for success, wrong/missing re-auth, exact confirmation, cookie/session revocation, pending login, restore, expired purge, replay/idempotency, audit redaction, and local-data preservation.

### Acceptance

- Account deletion is impossible without a current session, valid server-side re-authentication, and exact confirmation.
- A pending account has a clear recovery path for 30 days and is irreversibly purged after expiry.
- All account deletion transitions are observable through redacted audit events and contain no password, token, or host secret.

## Task 4: Secure cloud-sync deletion and stop background activity

### Files

- Modify: `src/server/http/sync-routes.ts`
- Modify: `src/server/sync/sync-service.ts`
- Modify: `src/server/sync/sync-coordinator.ts`
- Modify: sync service/route/coordinator tests

### Steps

1. Replace the cloud-delete request body with strict `{confirmDelete: "DELETE MY CLOUD VAULT"}`. Remove the client boolean proof and require a fresh session-bound server re-authentication for delete and restore.
2. Add a consistent pending-state guard: cloud deletion pending returns local-only state with countdown, while sync pull/push/preview/resolve/retry/recovery-key operations return `SYNC_DELETE_PENDING`; account deletion pending returns `ACCOUNT_DELETION_PENDING`.
3. Keep cloud deletion and account deletion state distinct in status responses and error handling. Restore must be idempotent only for the matching pending operation and must not restore an expired request.
4. Make `SyncCoordinator.markDirtyFromRequest`, `markDirty`, `retry`, `flush`, and `process` check deletion state before queuing or uploading. Cover the race where deletion starts while a flush is queued/in flight; no post-delete upload may be accepted.
5. Ensure expired cloud deletion purges the existing cloud rows and pending request, while account expiry invokes the full account purge path exactly once.
6. Add tests for forged boolean removal, re-auth expiry, all blocked operations, local-only status, coordinator race/queue behavior, restore, expiry, and redacted audit events.

### Acceptance

- A client cannot delete or restore cloud data by setting a JSON boolean.
- No queued or retrying background upload can write after deletion becomes pending.
- Cloud deletion keeps the account and local copy; account deletion keeps local copy but removes cloud/account state at expiry.

## Task 5: Wire Web API and modern deletion/recovery UI

### Files

- Modify: `src/client/web/api.ts`
- Modify: `src/client/web/adapters.ts`
- Modify: `src/client/web/components/AccountMenu.tsx`
- Modify: `src/client/web/components/SyncCenter.tsx`
- Modify: relevant client unit/component tests

### Steps

1. Add Web API methods for re-authentication, account deletion status/request/restore, and cloud deletion request/restore. Keep capability errors explicit when an older native/backend surface is unavailable.
2. Load and refresh deletion state alongside account/sync status, including after sign-in, sign-out, deletion, restore, device revoke, and sync failures.
3. In `AccountMenu`, add a security-sensitive but compact flow: password re-auth modal/step, exact confirmation text, clear distinction between “删除云端同步数据” and “删除账号”, irreversible/30-day copy, pending countdown, and restore action. Keep logout separate and preserve local data by default.
4. In `SyncCenter`, show local-only mode and blocked-sync reason while cloud deletion is pending; show account-deletion pending state without offering misleading sync controls. Make all loading/error/success states keyboard accessible and avoid accidental destructive submits.
5. Add component tests for validation, focus/escape behavior, pending countdown/restore, capability fallback, and no local-data deletion on logout/account deletion.

### Acceptance

- The UI clearly separates logout, cloud deletion, account deletion, and local-data deletion.
- Destructive actions require password and exact text confirmation, show the recovery window, and expose restore.
- Pending deletion state is understandable and does not present controls that will silently fail.

## Task 6: Add end-to-end lifecycle coverage

### Files

- Modify: account-enabled Playwright specs/config/helpers under `tests/e2e` (use repository paths)
- Add: local-only deletion preservation E2E if not covered by an existing spec
- Modify: test fixtures only as needed

### Steps

1. Add an account-enabled flow with a unique account/password/host marker: sign in, re-authenticate, request account deletion, verify cookie/session/device revocation and local host availability, sign in during the recovery window, restore, and verify sync resumes.
2. Add cloud-only deletion coverage: request cloud deletion, verify local-only status and blocked upload/pull/preview, restore with re-auth, and verify sync resumes.
3. Exercise expiry deterministically through the test database clock/request timestamp path rather than waiting 30 days; verify cloud/account rows are removed and unique local marker remains.
4. Run default E2E and account-enabled E2E with isolated temporary data directories. Move any retained diagnostic database to `/tmp` and scan artifacts for passwords, tokens, host secrets, and unique markers.

### Acceptance

- The browser verifies the full delete → pending → restore/expire lifecycle for both deletion levels.
- Local data remains usable after account deletion and expiry.
- E2E artifacts do not retain credentials or sensitive markers.

## Task 7: Release gate, documentation, and commit

### Files

- Modify: `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`
- Modify: `docs/superpowers/specs/2026-09-17-relay-account-deletion-design.md`
- Add/modify: only implementation files and tests listed above

### Steps

1. Run focused tests for every changed package and inspect failures rather than weakening assertions.
2. Run the complete release gate: full Vitest, `npm run typecheck`, `npm run lint`, `npm run build`, default E2E, account-enabled E2E, shared-boundary scan, and sensitive-data scan.
3. Review `git diff --check`, `git status`, migration ordering, API error/status consistency, and the final diff for unrelated changes. Confirm no test database, logs, screenshots, or secrets are staged.
4. Update the roadmap only after evidence passes: mark X-04D complete, record exact verification commands/results, and add the commit hash in a follow-up documentation amendment if needed.
5. Commit only the X-04D implementation, tests, and its roadmap/spec evidence. Do not push.

### Acceptance

- All required verification commands pass with recorded evidence.
- The roadmap and design implementation boundary match the shipped behavior.
- The commit contains no unrelated or sensitive files.

## Delivery record (2026-09-17)

- [x] Task 1 complete: shared deletion states, confirmation constants, ports, errors and native-like fake contract are implemented and covered.
- [x] Task 2 complete: session-bound 10-minute re-auth, schema v14, transactional account purge and local-data preservation are implemented and covered.
- [x] Task 3 complete: account deletion request/status/restore routes, pending recovery login, expiry cleanup and redacted audit behavior are implemented and covered.
- [x] Task 4 complete: cloud deletion re-auth, pending guards, coordinator race protection, restore and expiry behavior are implemented and covered.
- [x] Task 5 complete: Web API/adapters, AccountMenu and SyncCenter deletion/recovery flows with capability fallback are implemented and covered.
- [x] Task 6 complete: account-enabled Playwright coverage verifies account/cloud delete, recovery, expiry and local-data preservation; default and account E2E suites pass.
- [x] Task 7 complete: release gate passed, generated test data and reports were removed, roadmap/spec evidence was updated, and the final diff is limited to X-04D files.

**Release evidence:** `npx vitest run tests/unit/web/account-menu.dom.test.tsx` passed (`8/8`); `npm test` passed (`109 files / 518 tests`); `npm run typecheck`, `npm run lint`, and `npm run build` passed; default Playwright E2E passed (`4/4`); account-enabled Playwright E2E passed (`4/4`). Shared boundary scan found no Node, React, WebSocket, ssh2 or browser-storage dependency under `src/shared`. SQLite audit metadata and generated-artifact scans found no test password, token, host secret or marker; temporary databases and Playwright reports were removed before commit.

## Plan self-review

- [x] Scope is limited to X-04D and explicitly excludes local-data deletion.
- [x] Re-authentication, confirmation strings, pending states, expiry, restore, and local-data boundaries are explicit.
- [x] API, shared ports, server repositories/services, coordinator, UI, tests, and E2E surfaces are named.
- [x] Security and concurrency/race acceptance criteria are included.
- [x] Major-change release gate is explicit; routine edits remain task-focused.
