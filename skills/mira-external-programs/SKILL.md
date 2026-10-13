---
name: mira-external-programs
description: Build or connect an independent script, worker, or service to Mira using the external SDK, local access CLI, and ordinary file/Shell tools.
---

# Mira external programs

Use this for an independently running program. An in-process tool or managed
extension should normally use the existing extension SDK and lifecycle instead.
Reuse an existing capability before writing another one. This guide does not grant
permission, account access, persistent access, or external effects.

Read the current [External SDK README](../../packages/external-sdk/README.md)
before coding; it owns exact input/receipt/error contracts and working examples.
Use ordinary read/write/bash tools, not an invented management API.

1. Clarify the result and choose quiet fact, attention request, or ready-written
   Timeline notification. Do polling/filtering in ordinary software. A notification
   does not wake the model or send to another service; use requestWake for judgment.
2. Keep each source revision's full envelope in ordinary durable input before
   submitting it. Choose emitEvent OR requestWake for each event, never emit then
   upgrade the same ID. Do not generate fresh IDs/times merely to retry a timeout.
3. Inspect `pnpm external-access status` in the Mira source repository with the
   same MIRA_HOME as the server. When user intent authorizes the access change,
   use the documented create/enable/rotate/revoke commands. They output metadata
   only. Keep credentials outside source, Memory and extension artifact trees.
4. Pass the returned credentialFile path to the worker. Have the program read it
   privately at runtime through the SDK's per-request loader. Never read the token
   into tool output, paste it into source, or place it in command arguments,
   event payloads, notices, logs or model context. Same OS-account access is not
   isolation; do not claim the key is inaccessible to ordinary host tools.
5. Exercise the actual SDK/HTTP path with synthetic authorized inputs. Check the
   exact durable receipt, repeat delivery, cancellation/unknown outcomes, and
   rotation/revocation. A persisted receipt is not model completion or user read.
   Record what was actually tested; a mock does not prove PG or real account access.

The package is currently private source, not an npm release. Outside-repository
Node programs use the documented absolute source entry. No automatic package
installation, daemon manager, public listener or account integration is implied.
Read failures or uncertain sends should preserve the original envelope for explicit
reconciliation; do not silently reset the credential store or replay external effects.
