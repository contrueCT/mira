# MCP plugin

An ordinary trusted extension, one independent installation per MCP server. It imports only the public extension SDK plus official `@modelcontextprotocol/client@2.3.1`; no MCP manager, core vendor branches or Pi upgrade. Servers and their tool descriptions/results remain untrusted external data, never permission grants.

## Install and manage

Install server software at an explicit pinned version through its trusted distributor first. Do not launch `npx latest` on every connection. The plugin accepts an absolute installed executable; arguments must not contain secrets. Local stdio currently requires Linux/macOS process-group ownership.

Prepare this package through the same authoring workflow as any other package:

```sh
node scripts/prepare-extension-package.mts "$PWD/packages/mcp-plugin" /absolute/new-mcp-workspace
```

Then use ordinary `extension_stage`, content-bound artifact tests, and `extension_manage` install → activate. Use a different ordinary extension ID for each server. Existing configure, reload, update, rollback, disable and remove operations retain their existing meanings. No default installation or market lookup occurs. The agent can perform this same workflow with its ordinary tools; no manual-only MCP installation path is introduced.

Example complete configurations:

```json
{"transport":"stdio","command":"/absolute/node","argsJson":"[\"/absolute/pinned-server/index.js\"]","protocol":"legacy"}
```

```json
{"transport":"http","url":"https://example.org/mcp","protocol":"auto","auth":"oauth"}
```

`argsJson` and `toolsJson` are JSON arrays of strings. Empty `toolsJson` selects all tools; it is configuration, not an approval engine. Optional `cwd` must be absolute. `envSecrets` maps environment-variable names to private credential field names; supply their values in protected Settings, never config. The child inherits only PATH plus these explicit values; Node injection environment variables are rejected. Stderr is discarded to avoid leaking server diagnostics. Remote bearer tokens also use a protected secret field, `bearerToken`.

The Settings → Extensions panel shows connection state and Connect / Authorize / Refresh tools / Disconnect actions, plus Forget authorization for locally stored OAuth credentials. The installation-specific `mcp_control_*` tool invokes the same start/current/cancel action handle and returns only safe operation receipts. It never returns tokens, authorization URLs, callback codes or status details. Installation lifetime uses ordinary enable/disable; Disconnect closes the current connection only. Enabled installations reconnect on service restart; disabled installations stay off.

## Protocol and execution

Local defaults to the established legacy protocol (2025 servers). Choose `2026-07-28` for a modern-only server. HTTP defaults to official automatic negotiation. Local auto-probing is intentionally unavailable: the SDK base transport can launch a disposable sibling server even for a pinned modern probe. This plugin uses the SDK's documented subclass in-place negotiation, so each connect launches exactly one server. A protocol mismatch fails the connection and is shown in protected Settings.

Tool names combine the installation ID and remote name with deterministic hashes, within 64 portable characters. A complete tools-list candidate is validated before publication. The next natural model request sees new declarations; begun calls retain their exact client and remote schema; captured old declarations that have not begun return known stale/not-executed. Reload/update drains calls before retiring the old connection. This is not a zero-downtime or distributed atomic upgrade promise.

Text and structured content are supported. Structured JSON is included in model-visible text even when a human-readable summary is also present, and retained in durable details; an exactly identical JSON text block is not duplicated. Other content types are explicitly reported as undelivered rather than silently dropped or represented as successful text. MCP `isError` is a known failed result through durable outcome/recovery. Transport loss after an effect stays unknown. No automatic tool replay: SDK input auto-fulfilment is disabled; exact tool definitions prevent header-mismatch retries; effect transports use token-only auth (no automatic 401/403 authorization-and-retry). Expired tokens require an explicit Authorize action. Tools time out after 30 seconds; connect/list calls use bounded timeouts.

## OAuth

The default callback is `http://127.0.0.1:37391/oauth/callback` and requires the browser on the computer running Mira. For a browser on another computer, explicitly configure a provider-accepted HTTPS `redirectUrl` and `callbackPort` backed by an existing user-managed proxy to the local loopback listener. The plugin never opens public listeners, configures tunnels, changes firewall/network settings or assumes `localhost` on a phone reaches Mira. Occupied ports fail visibly rather than silently changing a registered callback.

Official SDK discovery, registration, PKCE and code exchange are reused. State and verifier are one-use, expire after five minutes, are cancelled with the settings action and do not survive restart. Callback issuer validation uses the SDK. Credentials are private per installation, exact server URL, issuer and registration; provider errors are sanitized before SDK warning paths. The protected settings panel alone displays an HTTPS authorization link/QR. Forget authorization deletes only this server’s local saved authorization and registration; it does not revoke the provider’s grant. No live-account authorization is part of synthetic acceptance tests.

No Tasks, Apps, sampling, roots access, automatic resources, prompts-to-skills conversion, or marketplace in this version. Rollback cannot undo remote effects. Cordis remains trusted in-process code, not a sandbox; process-group cleanup owns only the spawned POSIX group and cannot constrain a server that deliberately detaches itself.

## Verification

`mcp-plugin`, `mcp-http`, `mcp-runtime`, `mcp-oauth`, `mcp-generated-install` and `extension-toolsets` unit suites cover official SDK transports, dynamic revisions, known/unknown outcomes, ownership, credential isolation and the normal package/artifact lifecycle. `pnpm test:mcp:e2e` requires the explicit isolated PostgreSQL test database and Chromium; it exercises the production browser/HTTP/PG/runtime/Host chain with synthetic model and MCP endpoints. Tests never authenticate to a live provider.
