# SSH Interoperability Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a cross-product SSH connection migration flow that imports OpenSSH, generic/Termius CSV, MobaXterm, Xshell, and SecureCRT configuration into the encrypted Vault through a preview/apply workflow, while exporting standard OpenSSH config and generic CSV.

**Architecture:** Keep the existing encrypted `webssh-vault` bundle unchanged as the product backup format. Add a platform-neutral `src/shared/import` layer for canonical records, detection, normalization, parsers, deduplication, jump-chain resolution, and standard serializers. Add a server-side import service for multipart files, short-lived previews, credential handling, Vault transactions, and audit-safe reporting. Expose the service through `/api/import/*` and `/api/export/*`; extend the existing Web adapter and Workspace Settings UI without putting secrets in browser persistence. The shared model and pure parsers must remain usable by future desktop, Android, and Linux adapters.

**Tech Stack:** TypeScript, Zod, Fastify multipart, SQLite repositories/VaultService, Vitest, React Testing Library, `fflate` for bounded ZIP inspection, and `fast-xml-parser` for SecureCRT XML.

**Spec:** `docs/superpowers/specs/2026-09-15-ssh-interoperability-import-design.md`

## Global Constraints

- Preserve the existing encrypted Vault import/export API and behavior.
- Do not overwrite the user's existing uncommitted HostForm, styles, or DOM-test changes.
- Never log, persist, or return passwords, private keys, source passphrases, or unredacted uploaded files.
- Do not bypass third-party master passwords, OS keychains, or credential managers.
- Do not create database hosts without valid credentials; preview records may be incomplete, but apply requires a ready credential or an explicit credential supplied in the apply request.
- Normalize external records before database writes; parsers must not depend on React, DOM, ssh2, or SQLite.
- Treat explicit source fields as authoritative. Preserve unsupported fields only as redacted warnings/source metadata, never as guessed connection behavior.
- Run the smallest focused test command after each task, then run typecheck/lint/build and the relevant integration tests before claiming completion.

## File Map

### New files

- `src/shared/import/types.ts` — canonical records, formats, credential states, preview/apply/export contracts.
- `src/shared/import/normalize.ts` — field aliases, safe scalar parsing, group/tag normalization, credential-state calculation.
- `src/shared/import/detect.ts` — content/extension based format detection and supported-format hints.
- `src/shared/import/parsers/openssh.ts` — OpenSSH config parser.
- `src/shared/import/parsers/csv.ts` — generic/Termius-compatible CSV parser.
- `src/shared/import/parsers/mobaxterm.ts` — MobaXterm INI/`.mxtsessions` parser and encrypted-container warning.
- `src/shared/import/parsers/xshell.ts` — Xshell `.xsh` parser and protected-password state.
- `src/shared/import/parsers/securecrt.ts` — SecureCRT XML/INI parser and protected-password state.
- `src/shared/import/parsers/index.ts` — parser registry and dispatch.
- `src/shared/import/export.ts` — OpenSSH config and generic CSV serializers.
- `src/shared/import/dedupe.ts` — stable identity keys, conflict classification, jump reference resolution.
- `src/shared/import/zip.ts` — bounded ZIP entry extraction with path traversal and file-type checks.
- `src/server/workspace/ssh-import-service.ts` — preview context, import application, Vault transaction mapping, secret lifecycle.
- `src/server/api/ssh-import-routes.ts` — import preview/apply/formats and standard export routes.
- `tests/fixtures/import/openssh/config` — representative multi-hop OpenSSH fixture.
- `tests/fixtures/import/ssh.csv` — generic/Termius CSV fixture with quoted fields and incomplete credentials.
- `tests/fixtures/import/mobaxterm.mxtsessions` — MobaXterm folder and SSH session fixture.
- `tests/fixtures/import/session.xsh` — Xshell fixture with a protected/omitted password.
- `tests/fixtures/import/securecrt.xml` and `tests/fixtures/import/session.ini` — SecureCRT fixtures.
- `tests/unit/shared/import/*.test.ts` — pure parser/model/export tests.
- `tests/unit/server/ssh-import-service.test.ts` — preview/apply/security tests.
- `tests/integration/server/ssh-import-routes.test.ts` — authenticated multipart/API tests.

### Existing files to modify

- `package.json`, `package-lock.json` — add the bounded ZIP and XML parsing dependencies.
- `src/shared/errors.ts` — add import preview/format/conflict error codes and safe messages.
- `src/server/app.ts` — register the new routes after the existing Vault routes.
- `src/server/audit/audit-service.ts` or its typed call sites — record only aggregate import/export metadata if required by the existing audit API.
- `src/web/api.ts` — add external import/export request/response types and methods while preserving Vault bundle types.
- `src/web/platform/web-adapters.ts` — extend the workspace adapter contract with external preview/apply and standard export operations.
- `src/web/components/WorkspaceSettings.tsx` — add separate cross-product import/export controls, preview, credential补录, conflict selection, and download handling.
- `src/web/styles.css` — style the new settings sections using existing tokens/components.
- `tests/unit/web/web-adapters.test.ts` and `tests/unit/web/workspace-settings.dom.test.tsx` — cover request mapping, preview, apply, and secret non-persistence.

## Task 1: Establish the shared exchange model and format detection

**Files:** `src/shared/import/types.ts`, `src/shared/import/normalize.ts`, `src/shared/import/detect.ts`, `src/shared/errors.ts`, `tests/unit/shared/import/types.test.ts`, `tests/unit/shared/import/detect.test.ts`

1. Write failing tests for `ImportFormat`, `ImportedCredentialState`, canonical connection/document types, safe preview DTOs, supported-format output, and detection of OpenSSH, CSV, MobaXterm, Xshell, and SecureCRT samples.
2. Run `npx vitest run tests/unit/shared/import/types.test.ts tests/unit/shared/import/detect.test.ts`; confirm the tests fail because the shared module does not exist.
3. Implement the types and pure helpers. Include `ImportSourceFile`, `ImportPreview`, `ImportApplyRequest`, `ImportApplyResult`, `ExportOptions`, and a preview-safe connection type that excludes secret material.
4. Normalize header names case-insensitively and collapse whitespace, but keep original source field names only in parser-local metadata. Add a `redactSourceFields` helper that never returns values for password/private-key/passphrase keys.
5. Add explicit app errors for unsupported/ambiguous format, expired external preview, invalid apply request, and invalid import record; retain existing Vault bundle errors.
6. Re-run the focused tests and `npx tsc -p tsconfig.json --noEmit`.

## Task 2: Implement OpenSSH and CSV parsing with normalization

**Files:** `src/shared/import/parsers/openssh.ts`, `src/shared/import/parsers/csv.ts`, `src/shared/import/parsers/index.ts`, `tests/fixtures/import/openssh/config`, `tests/fixtures/import/ssh.csv`, `tests/unit/shared/import/openssh.test.ts`, `tests/unit/shared/import/csv.test.ts`

1. Add failing tests for multiple `Host` aliases, `HostName`, `Port`, `User`, `IdentityFile`, comma-separated multi-hop `ProxyJump`, comments/quoting, wildcard blocks, CRLF CSV, quoted commas, reordered columns, Termius aliases, tags, groups, password/private-key columns, and missing credentials.
2. Run the focused tests and verify they fail before parser code is added.
3. Implement an OpenSSH parser that ignores wildcard-only defaults as connection records, expands concrete aliases, preserves `IdentityFile`, creates source IDs stable within the document, and converts `ProxyJump` entries into source references without interpreting `ProxyCommand`.
4. Implement a small RFC-4180-compatible CSV reader (quoted values, escaped quotes, CRLF) and alias mapping for `name/label/title/session`, `host/address/hostname/ip`, `user/username`, `group/folder`, `private_key/privateKey/identityFile`, `jumpHost/proxyJump`, and `tags`.
5. Normalize hostnames, ports, group paths, tags, and auth state. Mark password/private-key values as ready only inside the internal document; ensure the public preview mapper strips them.
6. Run focused parser tests, shared typecheck, and `git diff --check`.

## Task 3: Implement vendor parsers and bounded file handling

**Files:** `src/shared/import/parsers/mobaxterm.ts`, `src/shared/import/parsers/xshell.ts`, `src/shared/import/parsers/securecrt.ts`, `src/shared/import/zip.ts`, `src/shared/import/parsers/index.ts`, `package.json`, `package-lock.json`, vendor fixtures, `tests/unit/shared/import/vendor-parsers.test.ts`, `tests/unit/shared/import/zip.test.ts`

1. Add failing tests for MobaXterm `.mxtsessions`/INI folder hierarchy and SSH records, Xshell `.xsh` host/port/user/auth fields, SecureCRT XML and session INI records, and protected/omitted credentials becoming `needs-source-passphrase` or `needs-user-input` rather than fabricated passwords.
2. Run the focused tests and verify failure before implementation.
3. Add `fflate` and `fast-xml-parser` using the package manager, then implement bounded ZIP extraction. Reject absolute paths, `..` traversal, unsupported binaries, excessive entry count, and decompressed-size limits; never write entries to disk.
4. Implement MobaXterm INI parsing with CP1252-compatible byte decoding, preserve nested bookmark paths, extract SSH host/port/user/private-key references, and emit a warning for encrypted `.mobaconf` content that cannot be read without its passphrase.
5. Implement Xshell key/value parsing for common `.xsh` fields and map protected/absent password fields to explicit credential states. Do not attempt to reverse encoded passwords.
6. Implement SecureCRT XML and INI parsing using only recognized session fields. Treat omitted/encrypted sensitive fields as incomplete and preserve a redacted warning.
7. Register all parsers and ensure auto-detection uses content first, extension second. Run focused vendor/ZIP tests and typecheck.

## Task 4: Add deduplication, jump resolution, and standard exporters

**Files:** `src/shared/import/dedupe.ts`, `src/shared/import/export.ts`, `tests/unit/shared/import/dedupe.test.ts`, `tests/unit/shared/import/export.test.ts`

1. Add failing tests for stable identity (`normalized address + port + username`), same-batch duplicate collapse, existing-host conflict classification, source-ID/name/path jump matching, unresolved jump warnings, multi-hop ordering, OpenSSH export quoting/alias uniqueness, CSV escaping, and the default omission of passwords.
2. Run the focused tests and verify they fail before implementation.
3. Implement normalization and resolution as pure functions. A target with unresolved jump references remains in the preview but is not directly applicable until the user removes or resolves the reference.
4. Implement OpenSSH export for aliases, `HostName`, `Port` when non-default, `User`, `IdentityFile`, and `ProxyJump`; omit passwords and unsupported proxy commands.
5. Implement generic CSV export with stable columns, escaped values, optional explicit `includePasswords`, and an API-facing redaction boundary. Password inclusion must be opt-in in the type and never the default.
6. Run focused tests, typecheck, and inspect generated strings for accidental secrets in default output.

## Task 5: Build the server-side preview/apply service

**Files:** `src/server/workspace/ssh-import-service.ts`, `src/server/db/repositories.ts` only if a narrow query/helper is needed, `tests/unit/server/ssh-import-service.test.ts`

1. Add failing service tests for preview TTL, aggregate limits, parser dispatch, safe preview serialization, credential补录, skip/apply selection, conflict policies (`skip`, `create`, `replace` only when explicit), group creation, jump-host dependency ordering, rollback on failure, and no secret leakage to audit/log payloads.
2. Run the focused test file and confirm red.
3. Implement `SshImportService.preview(files, options)` with in-memory/TTL contexts keyed by opaque IDs. Store secret material only in the context, not in the preview DTO or browser-facing logs.
4. Implement `apply(previewId, request)` to revalidate the canonical records, require valid credentials for every selected record, resolve/create groups, create hosts through the existing Vault/repository transaction path, and apply dependencies before targets. Do not mutate existing hosts unless `replace` is explicitly selected.
5. Implement `listFormats()` and `exportOpenSsh/exportCsv()` from current Vault metadata plus decrypted credentials only inside the request lifetime. Default CSV output excludes passwords; audit payloads contain format/count/status/duration only.
6. Add cleanup of expired contexts and deterministic error mapping. Run focused service tests and server typecheck.

## Task 6: Expose authenticated import/export routes

**Files:** `src/server/api/ssh-import-routes.ts`, `src/server/app.ts`, `tests/integration/server/ssh-import-routes.test.ts`

1. Add failing integration tests for unauthenticated rejection, `/api/import/formats`, multipart preview with multiple files, preview response redaction, expired/apply validation, conflict handling, `/api/export/openssh`, and `/api/export/csv` content-disposition/content-type.
2. Run the focused integration tests and verify they fail before route registration.
3. Register the routes after the existing Vault routes and protect all operations with `requireUnlockedSession`.
4. Parse multipart fields with explicit limits; accept optional format hint, source passphrase fields only for the current request, and never include uploaded file contents in error messages.
5. Map service errors to existing/new `AppError` codes and return only safe DTOs. Set download headers without reflecting untrusted filenames.
6. Run the focused integration tests and relevant existing workspace route tests; run server typecheck.

## Task 7: Integrate the Web workflow without browser secret persistence

**Files:** `src/web/api.ts`, `src/web/platform/web-adapters.ts`, `src/web/components/WorkspaceSettings.tsx`, `src/web/styles.css`, `tests/unit/web/web-adapters.test.ts`, `tests/unit/web/workspace-settings.dom.test.tsx`

1. Add failing DOM/API tests for selecting external files, showing detected format/record counts/conflicts/jump warnings/credential states, entering a source passphrase or per-record credential, applying only selected records, downloading OpenSSH/CSV, and ensuring no imported secret appears in `localStorage`, `sessionStorage`, rendered preview text, or request logs.
2. Run the focused Web tests and verify red.
3. Extend the Web API/adapter with multipart preview/apply and Blob export methods while leaving encrypted Vault bundle methods unchanged.
4. Add a distinct “跨产品迁移” section in Workspace Settings. Use transient React state and `URL.createObjectURL` downloads; revoke object URLs and clear file/secret state after completion or close.
5. Render safe warnings and explicit credential补录 controls. Disable apply for incomplete records until a valid credential is supplied or the record is deselected. Keep conflict policy visible and default to skip.
6. Run focused Web tests, typecheck, and lint for changed files.

## Task 8: Documentation, compatibility fixtures, and verification

**Files:** `docs/superpowers/specs/2026-09-15-ssh-interoperability-import-design.md` if behavior changed, relevant README/help copy, all import fixtures/tests

1. Add parser fixture notes and user-facing field/credential behavior documentation, including the distinction between encrypted Vault backup and cross-product migration.
2. Add a round-trip test matrix: OpenSSH parse → export → parse, CSV parse → export → parse, and vendor parse → canonical preview.
3. Run focused unit/integration tests for the new feature first. Then run `npm run typecheck`, `npm run lint`, `npm run build`, and the complete test suite once at the final verification checkpoint; record the exact results.
4. Inspect `git diff --check`, `git status`, and the final diff to ensure existing user changes are preserved and no secrets/fixtures contain real credentials.
5. Use `superpowers:finishing-a-development-branch` to decide whether to commit the feature separately from the user's pre-existing changes. Do not push unless explicitly requested.

## Verification Checklist

- Shared modules compile in both browser and Node TypeScript targets.
- Preview never includes password/private-key/passphrase values.
- Default OpenSSH/CSV export has no passwords; password export requires explicit confirmation.
- Encrypted or unreadable vendor credentials are represented as a clear补录 state, never guessed.
- Preview/apply is authenticated, bounded, expiring, and transactionally safe.
- Existing Vault bundle import/export remains unchanged.
- Web UI uses transient state and clears secrets after use.
- All focused tests pass before the final full verification run.
