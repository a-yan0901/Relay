# Terminal Appearance Profiles Design

**Date:** 2026-09-17

## Goal

Deliver a Termius-like terminal appearance system: a Vault-scoped library of terminal profiles, a Vault default, and an optional profile per Server. Profiles must survive encrypted Vault bundle export/import and encrypted account sync, while the existing application UI theme remains a browser-local preference.

## Context

Relay currently has seven application themes in `src/web/theme.ts`. Each couples UI CSS tokens with a terminal ANSI palette. `TerminalPanel` creates xterm.js with a fixed font family, the global font size, fixed 1.25 line height, blinking cursor, fixed scrollback, and the current UI theme palette. Existing `UiPreferences` intentionally lives only in browser localStorage.

Termius publicly describes per-connection terminal theme and font customization. xterm.js natively supports the terminal theme palette, font family/size, line height, cursor style, cursor blinking, and scrollback. Transparent terminal backgrounds require `allowTransparency` when constructing the terminal, can reduce performance, and are intentionally out of scope for this release.

## Product Decisions

- Built-in profiles are immutable code constants. They include the current seven terminal palettes and are always available; they are not copied to the database or bundle.
- A user-created profile is Vault data. It has a stable identifier, a unique name per Vault owner, and a complete terminal appearance definition.
- A Vault stores one default profile reference. New and existing Hosts inherit it when their `terminalProfileId` is null.
- A Host may select either inheritance or an explicit profile. It stores only the selected profile ID, not a duplicated palette.
- Deleting a custom profile is rejected if it is the Vault default or selected by any Host. The UI explains where it is in use.
- UI theme selection remains browser-local. Changing it no longer changes the terminal palette; terminals use the resolved Vault profile instead.
- Custom profiles and profile assignments are included in encrypted Vault bundle payloads and account sync snapshots. Existing bundles/snapshots without profile data retain their legacy behavior by resolving to the built-in Midnight profile.

## Data Model

### Shared terminal appearance types

Add a shared `TerminalAppearance` model with:

- `foreground`, `background`, `cursor`, `cursorAccent`, `selectionBackground`, `selectionForeground`
- all 16 ANSI colors (`black` … `brightWhite`)
- `fontFamily` (1–160 characters, no control characters)
- `fontSize` (10–24 integer pixels)
- `lineHeight` (1.0–2.0, increments are not constrained by storage)
- `cursorStyle` (`block`, `bar`, `underline`)
- `cursorBlink` boolean
- `scrollback` (500–20,000 lines)

A `TerminalProfile` consists of `id`, `name`, `appearance`, `createdAt`, and `updatedAt`. The built-in profile catalog uses the same public appearance shape but has IDs prefixed with `builtin:` and is never writable.

### Persistence

Add:

- `terminal_profiles`: owner-scoped custom profiles with JSON appearance and timestamps.
- `terminal_preferences`: one owner-scoped row containing `default_profile_id`; built-in IDs are permitted.
- nullable `hosts.terminal_profile_id`: null means inherit the owner default. A foreign-key constraint is not used because a Host may refer to an immutable built-in ID; repository validation enforces custom-profile ownership.

Database migration backfills no host rows and creates a default preference of `builtin:midnight` for each existing owner on first read. This makes migration idempotent and preserves the current visual result.

### API and Vault bundle

- Add CRUD routes for profiles and a get/update default-profile route, all requiring the unlocked Vault session.
- Extend Host create/patch validation and Host metadata with nullable `terminalProfileId` and resolved profile data only where required by the web client. Server responses never need to expose unrelated custom profiles through a Host.
- Bundle schema moves from version 1 to version 2. Version 1 parsing remains supported and synthesizes `terminalProfiles: []` plus default `builtin:midnight`.
- Bundle version 2 contains top-level `terminalProfiles` and `terminalPreferences`, and hosts contain nullable `terminalProfileId`.
- Sync snapshots reuse the bundle payload shape, so snapshot validation, sync conflict export, and recovery preview all gain profiles automatically. Conflict handling adds a terminal-profile resolution policy: reuse same-name profiles when equal; otherwise import as a renamed profile, never silently overwrite an existing unrelated profile.

## UI and Interaction

### Settings > Terminal appearance

Replace the current terminal-coupled theme selector with separate sections:

1. **Application appearance** retains the current local UI theme selector.
2. **Terminal appearance** shows the Vault default profile, a compact terminal preview, and profile management.

The profile manager supports selecting a built-in or custom default; creating, editing, duplicating, and deleting custom profiles. The editor presents semantic colors and the 16 ANSI slots in a grouped grid, with live terminal preview. Typography and cursor controls share the preview. Reset restores the selected built-in profile values before saving a custom profile.

### Host editor

Add a Terminal appearance fieldset with radio choices:

- Inherit Vault default (shows resolved profile name)
- Use a selected profile

The select lists built-ins followed by custom profiles. This setting is metadata, so opening or saving it never touches Host credentials.

### Live terminals

`App` loads the profile catalog after unlock alongside hosts/groups. `TerminalWorkspace` resolves each tab’s Host profile against the Vault default and passes the resulting appearance into `TerminalPanel`.

`TerminalPanel` applies font, theme, cursor and scrollback at construction. A preference/profile update updates all mutable xterm options in place using a new theme object. The terminal is not recreated, the SSH connection remains open, and terminal contents remain intact. A changed scrollback limit affects future retention only.

## Error Handling and Invariants

- All profile input is strict-schema validated on client and server. Color fields accept only normalized CSS hex colors; opacity and arbitrary CSS strings are rejected.
- A missing or inaccessible profile ID in a Host mutation returns a validation error; imported unknown IDs fall back to inheritance only when loading legacy version-1 data.
- A custom profile cannot be deleted while referenced. Built-ins cannot be edited or deleted.
- Profile updates do not alter Host connection properties, terminal descriptors, SSH credentials, or account session state.
- Import preview counts profiles and reports conflicts. Apply is transactional with Host/profile validation before writes.
- xterm.js transparency, background images, uploaded fonts and arbitrary CSS are excluded for performance, readability and injection safety.

## Test Strategy

1. Unit tests for appearance validation, built-in profile resolution, fallback rules, profile repository ownership, and deletion guards.
2. Migration tests for an existing database and idempotent default-preference creation.
3. Route/integration tests for profile CRUD, Host assignment, invalid IDs, bundle v1 compatibility, bundle v2 round-trip, and sync snapshot/recovery preservation.
4. Web DOM tests for profile management, Host inheritance/override selection, and xterm option updates without terminal re-creation.
5. Existing theme tests are updated to prove UI theme changes no longer overwrite terminal profile selection.
6. Verification: relevant unit/integration/web test suites, `npm run typecheck`, `npm run lint`, and `npm run build`.

## Out of Scope

- Per-terminal-tab temporary overrides.
- Background images, blur, transparency controls, shaders, or arbitrary CSS.
- Font file upload, remote font fetching, or syncing browser-installed font binaries.
- Importing third-party terminal-theme file formats in this release. Users can create a Relay custom profile manually; a future importer can map those formats onto the same model.
