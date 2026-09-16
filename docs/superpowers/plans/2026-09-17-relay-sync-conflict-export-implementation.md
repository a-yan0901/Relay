# Relay 同步冲突加密导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Each step uses checkbox syntax for tracking.

**Goal:** 完成路线图 X-04C：在已登录且 Vault 已解锁的账号同步场景中，将 unresolved conflict 的 local/remote 两份完整同步 snapshot 导出为同一个、可分别恢复的加密 JSON 包；导出只读，不改变冲突状态。

**Architecture:** 继续沿用当前 Web server-mediated 的受信 Relay 边界。服务端读取并短暂解密两个 SyncEnvelope，验证完整 SyncSnapshot，分别用本次输入的导出密码派生 wrapping key，并为每一侧生成独立的 bundle key 后重新加密。shared core 只定义 wire contract、严格解析和 SyncPort，不引用 Blob、File、URL、DOM、Node stream 或 server-only EncryptedJson。Web platform adapter 提供 FileSavePort，UI 只负责收集一次性密码、调用 SyncPort、把返回包序列化后交给文件能力保存。

**Tech Stack:** TypeScript 6 · React 19 · Fastify 5 · zod 4 · Node crypto/argon2 · Vitest · Playwright · SQLite

**Spec:** [2026-09-17-relay-sync-conflict-export-design.md](/root/code/ssh-tools/docs/superpowers/specs/2026-09-17-relay-sync-conflict-export-design.md)

## Global constraints

- 直接在当前 /root/code/ssh-tools 工作区执行；这是用户明确要求的 inline execution，不创建额外 worktree。
- 导出包顶层 exact keys 为 format、version、conflictId、createdAt、copies；copies 必须恰好一次 local 和一次 remote。
- 每侧使用随机 16-byte salt、独立随机 32-byte bundle key、随机 AES-256-GCM nonce/auth tag；Argon2id 固定使用现有参数 memoryCost=19456、timeCost=2、parallelism=1、hashLength=32。
- 两侧 AAD 固定为 relay-sync-conflict:v1:<conflictId>:local|remote；payloadHash 原样保留源 SyncEnvelope.payloadHash，不把它误称为明文 hash。
- 明文必须是现有 SyncSnapshotService.validate 接受的完整 snapshot，覆盖 Host、Identity、Group、Snippet、Workspace；不得包含 envelope、账号 session、token、终端状态、导出密码或运行时对象。
- 单侧明文上限复用 SYNC_MAX_PAYLOAD_BYTES（32 MiB），序列化后的整体包不超过 96 MiB；生成超限时不返回局部 copy。
- 所有密码、明文 snapshot、同步 key、导出 key、bundle key 在服务端生命周期结束时清零；不得落入数据库、审计 metadata、日志、URL、localStorage、sessionStorage、文件名或普通错误消息。
- API 只接受严格 body { exportPassword: string }，长度为 8–4096 Unicode code units；成功响应 application/json、Cache-Control: no-store，并且成功后 conflict 仍 unresolved。
- export-both 不再调用 resolveConflict；UI 的“导出两份”必须打开导出流程。只有 keep-local/use-remote 才会改变冲突状态。
- 该功能触及 crypto、SyncPort、账号权限和跨模块响应；完成 focused 测试后执行完整 release gate：npm test、npm run typecheck、npm run lint、npm run build、默认 E2E、account-enabled E2E 和敏感数据扫描。

---

## Task 1: 建立 shared conflict-export contract 与严格 parser

**Files:**

- Modify src/shared/core/models.ts near WrappedKeyEnvelope/SyncPreview to expose SyncConflictExportKdf、SyncConflictExportCopy、SyncConflictExport。
- Create src/shared/core/sync-conflict-export.ts for format constants, strict parser, serializer, bounds, and base64/envelope validation.
- Modify src/shared/core/ports.ts to import SyncConflictExport, add FileSaveRequest/FileSavePort to optional platform services, and add SyncPort.exportConflict。
- Modify tests/fixtures/native-runtime.ts with a deterministic in-memory exportConflict implementation so all native-like contract fixtures remain valid.
- Extend tests/unit/shared/account-sync-contract.test.ts or add tests/unit/shared/sync-conflict-export.test.ts for parser and serializer behavior.
- Extend tests/unit/shared/core-adapter-contract.test.ts only where the new required SyncPort method makes the fixture contract explicit.

**Red step:**

- First write tests for exact top-level/copy keys, one local plus one remote, fixed KDF values, base64 nonce/authTag/salt lengths, 32 MiB payload ciphertext bound, 96 MiB serialized-package bound, safe conflict IDs, ISO createdAt, and rejection of plaintext-looking extra fields.
- Run npx vitest run tests/unit/shared/sync-conflict-export.test.ts tests/unit/shared/account-sync-contract.test.ts and observe the expected missing type/parser failures.

**Green step:**

- Define shared types using WrappedKeyEnvelope; do not import src/server/vault/types.ts。
- Implement a browser/server-neutral base64 shape/decoded-length check without Buffer; enforce envelope version 1, nonce 12 bytes, auth tag 16 bytes, and valid ciphertext lengths.
- Implement parseSyncConflictExport(value: unknown): SyncConflictExport and serializeSyncConflictExport(value: SyncConflictExport): string；both must revalidate exact shape and enforce package size. Keep all returned arrays readonly at the public boundary.
- Add exportConflict to fixture ports with an opaque deterministic contract value, not a plaintext snapshot.
- Re-run the focused tests and then the existing shared contract tests.

**Checkpoint:** git diff --check；focused shared tests pass；no shared file imports browser or Node-only APIs。

## Task 2: Implement the server-only encrypted package format

**Files:**

- Create src/server/sync/sync-conflict-export.ts。
- Add tests/unit/server/sync-conflict-export.test.ts。

**Red step:**

- Write tests for two independently encrypted copies, distinct salts/nonces/ciphertexts, exact AAD, successful decryption with the correct password, failure with a wrong password or swapped copy, and failure after tampering with header/envelope/ciphertext.
- Add a test that the output parser accepts a real package and that payload bytes round-trip to the original validated snapshot.
- Run npx vitest run tests/unit/server/sync-conflict-export.test.ts；it must fail before the module exists.

**Green step:**

- Export createSyncConflictExportCopy/decryptSyncConflictExportCopy (or equivalent narrowly scoped functions) and use existing deriveVaultKeyEncryptionKey、encryptBytes、decryptBytes、decodeSalt、ARGON2ID_PARAMS、and vault byte-length constants.
- For each copy derive the password key from a fresh random salt, create a fresh random 32-byte bundle key, wrap that key, then encrypt the canonical snapshot bytes. Use the exact side-specific AAD for both envelopes and retain source revision/hash metadata.
- Map malformed/tampered export material to a stable AppError without leaking crypto details. Validate package size before returning a complete result.
- Zero plaintext copies, salt, derived key, bundle key, and temporary decrypt buffers in finally blocks. Do not retain a package plaintext in module state.
- Use shared parser/serializer for wire validation so server and Web response cannot diverge.

**Checkpoint:** focused crypto tests pass；inspect test output and source to ensure no password or snapshot is included in error/audit strings。

## Task 3: Add readonly SyncService integration and strict Fastify route

**Files:**

- Modify src/server/sync/sync-service.ts to add exportConflict to SyncServiceContract and SyncService。
- Modify src/server/sync/sync-routes.ts with the strict request schema and export endpoint。
- Extend tests/integration/server/sync-routes.test.ts with export-specific setup/helpers and route assertions。

**Red step:**

- Add integration cases for unauthenticated account, missing Vault session, unknown/resolved conflict, extra/short/long request fields, successful export, wrong/stale conflict state, corrupted local/remote envelope, and export package size/crypto errors.
- Seed an unresolved conflict from two real encrypted envelopes inside the integration test database. After success decrypt both copies with the test helper and validate they contain the complete snapshot scope.
- Assert the response/body, database, audit rows, and captured logs never contain the export password, Host address/name, credential marker, snippet command, or workspace marker. Assert the conflict row remains unresolved and the current head/client state is unchanged.
- Run the focused integration test and observe the expected missing-route failures.

**Green step:**

- In SyncService.exportConflict(accountId, ownerId, vaultKey, conflictId, exportPassword), load only the current unresolved conflict, require a descriptor, verify both source envelopes match descriptor vault/key metadata, unwrap the sync key, decrypt one side at a time, call snapshotService.validate, and create both package copies.
- Re-read the unresolved conflict metadata after encryption. If it disappeared or any source revision/hash/envelope changed, throw SYNC_CONFLICT and return no partial package.
- Convert source decrypt/schema failures to SYNC_PAYLOAD_INVALID; preserve SYNC_NOT_FOUND、SYNC_NOT_ENABLED、and key-version errors as stable codes. Do not call savePending、resolveConflict、clearClientState、or any mutation method.
- In the route, require feature flag, account session, and unlocked Vault session; parse conflictId and the exact password body; call the service; audit only event type, conflict ID, source revisions and result; reply with type application/json, cache-control no-store, and the complete package.
- Keep the existing /resolve route behavior for keep-local/use-remote and continue rejecting direct export-both calls with the existing guidance.

**Checkpoint:** focused integration tests pass；git diff --check；rg confirms export password is absent from audit metadata and persistence writes。

## Task 4: Wire Web API, Sync adapter, and platform file-save capability

**Files:**

- Modify src/web/api.ts to add WebSyncApi.exportConflict, strict response parsing, and the POST request。
- Modify src/web/platform/web-adapters.ts to expose the optional API method and implement WebSync.exportConflict。
- Modify src/shared/core/ports.ts as needed for FileSaveRequest/FileSavePort。
- Modify src/web/platform/browser-system-services.ts to add BrowserFileHost, capability detection, and a default one-shot Blob/anchor save implementation entirely in the Web adapter。
- Extend tests/unit/web/api.test.ts、tests/unit/web/web-adapters.test.ts、and tests/unit/web/browser-system-services.test.ts。

**Red step:**

- Test that Web API posts only { exportPassword } to the encoded conflict URL and strictly rejects malformed response packages.
- Test that a missing optional exportConflict method produces CAPABILITY_UNAVAILABLE while the rest of WebSync still negotiates.
- Test that a browser file host receives UTF-8 bytes, the fixed MIME type, and the restricted filename; rejected browser APIs map to CAPABILITY_UNAVAILABLE.
- Run the three focused files before implementation and observe the expected failures.

**Green step:**

- Keep export optional in hasSyncApi; older servers without this endpoint must still provide status/preview/resolve, while WebSync.exportConflict checks with requireApi.
- Parse the response with parseSyncConflictExport; never expose a response Blob or stream to shared core.
- Add fileSave?: FileSavePort to the default browser platform services. The fallback must create a Blob from bytes, trigger one download, remove the temporary anchor, and revoke the object URL. It must not persist or log content.
- Serialize the validated package in the Web boundary, encode with TextEncoder, use filename relay-sync-conflict-<restricted conflictId>.json, and MIME application/json;charset=utf-8.
- Preserve custom platformServices injection behavior so desktop/Android can provide their own file ability later.

**Checkpoint:** focused Web API/adapter/system tests pass；missing file support is a capability error and no DOM/file type appears in shared core。

## Task 5: Implement Sync Center export interaction

**Files:**

- Modify src/web/components/SyncCenter.tsx。
- Modify src/web/App.tsx to pass runtime.platformServices?.fileSave in both SyncCenter render paths。
- Modify src/web/styles.css for the compact export form/dialog and mobile layout。
- Extend tests/unit/web/sync-center.dom.test.tsx；add App DOM coverage only if prop plumbing needs direct verification。

**Red step:**

- Add DOM tests that open “导出两份”, require two password fields and matching values with minimum length 8, disable the submit while busy, show retryable errors, clear fields on cancel/error/success, and never call resolveConflict。
- Provide a fake FileSavePort and an opaque SyncConflictExport result; assert the saved bytes parse as the package and the filename contains only the conflict ID。
- Add a stale/not-found test that closes the old preview, asks the user to reload, and leaves the conflict unresolved。
- Run npx vitest run tests/unit/web/sync-center.dom.test.tsx before implementation and observe expected failures.

**Green step:**

- Add controlled password/confirmation state only inside SyncCenter; use type=password、autoComplete=new-password、and never put the values in shared state or error text。
- Replace the old direct resolve('export-both') action with an export form. Show local/remote revisions, conflict type labels, readonly explanation, the export-password-vs-account-password warning, and the file-loss warning.
- On submit validate length and equality, require fileSave, call syncPort.exportConflict, serialize/encode the returned package, and call fileSave.save. Use one busy state to prevent duplicate export or resolution actions.
- On success clear password state and package references, close only the export form, show a redacted success message, and keep visibleStatus === conflict plus the existing preview. On cancel, error, unmount, SYNC_CONFLICT, or SYNC_NOT_FOUND, clear secrets; stale errors must clear the preview and trigger the existing reload effect without auto-resolving.
- Keep all existing recovery/device/sync interactions unchanged. Add minimal CSS that follows current Relay compact panel style and responsive full-width buttons.

**Checkpoint:** SyncCenter DOM tests and existing account/recovery tests pass；inspect rendered text for absence of host addresses, usernames, commands, passwords, and tokens。

## Task 6: Extend account-enabled and Local-only E2E coverage

**Files:**

- Modify tests/e2e/account-sync.spec.ts。
- Modify an existing non-account E2E spec only if a Local-only assertion needs a shared Sync Center path。

**Red step:**

- Add a serial account-enabled scenario that obtains two real encrypted envelopes, seeds one unresolved conflict row/client state in .tmp-e2e-account-data/webssh.sqlite, reloads the unlocked page, opens Sync Center, saves the encrypted package, and verifies the download filename and raw bytes。
- Use a password and payload markers unique to the test; assert raw response, DB sync rows, audit metadata and captured server output do not contain them. Assert the package can be decrypted in a test-side helper and includes both revisions, then reopen the center and prove keep-local/use-remote remain available after a successful export。
- Add/extend default Local-only coverage to assert no export button is rendered and no account/sync request is made when capabilities are filtered。
- Run only the relevant Playwright spec first, expecting failures before the UI/API are wired.

**Green step:**

- Seed only test data required to create a realistic unresolved conflict; do not add production-only test endpoints or weaken server validation。
- Keep the E2E cleanup/recovery ordering valid: export assertions must complete before device revoke/logout and before the reset-local-Vault recovery test。
- Run npx playwright test tests/e2e/account-sync.spec.ts with account mode and then the default E2E suite。

**Checkpoint:** account-enabled and default E2E pass；download is one file with the restricted name；no sensitive marker appears outside the encrypted package ciphertext。

## Task 7: Release verification, roadmap evidence, and commit

**Files:**

- Modify docs/superpowers/plans/2026-09-17-relay-sync-conflict-export-implementation.md checkboxes and evidence notes。
- Modify docs/superpowers/roadmaps/2026-09-16-relay-long-term-roadmap.md only to mark X-04C complete and record the verification commit/evidence；leave X-04D untouched。
- Add or update security-scan notes only in the relevant existing roadmap/evidence section。

**Verification sequence:**

- Focused shared/server/Web tests for every changed module。
- npm test
- npm run typecheck
- npm run lint
- npm run build
- npm run test:e2e
- ACCOUNT_SYNC_E2E=true npm run test:e2e -- tests/e2e/account-sync.spec.ts
- Sensitive-data scan over source, tests, audit metadata, SQLite rows and E2E output for the unique test password/markers and known plaintext fields。
- git diff --check、git status --short、and review git diff to confirm only X-04C files changed。

Only after all commands have fresh passing evidence:

- mark all plan tasks complete;
- mark roadmap X-04C [x] with commit/evidence, preserving the risk-based validation rule for later small changes;
- create one focused commit such as feat: add encrypted sync conflict export;
- do not push.

## Plan self-review

- [x] Each task has named files, a failing test step, implementation scope, and a checkpoint.
- [x] The shared/server type boundary is explicit: shared uses WrappedKeyEnvelope; server may use EncryptedJson internally only.
- [x] The plan preserves readonly semantics and defines post-success conflict behavior.
- [x] It covers password/snapshot/key zeroing, exact response parsing, audit/log/storage leakage checks, and both E2E modes.
- [x] It uses the requested current workspace and risk-based full verification because this is a major crypto/account/core change.
