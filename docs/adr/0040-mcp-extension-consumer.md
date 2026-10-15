# ADR 0040: MCP as an ordinary extension consumer

Status: user-approved design; implementation acceptance tracked by checks, not assumed from this document.

One generic MCP package is instantiated as independent ordinary extensions, reusing package preparation, stage/test/install/activate/configure/update/rollback/disable/remove. No second MCP manager, lifecycle ledger, screen or core vendor branches. Core additions are limited to atomic replaceable toolsets and optional known-failure `isError` outcomes. MCP protocol and OAuth behavior remain inside the plugin.

The official TypeScript client is independently pinned at 2.3.1. Pi stays at 1.0.2. Both 2026-07-28 and legacy servers are supported. HTTP uses official negotiation; stdio defaults legacy and allows explicit modern selection. The SDK's documented subclass in-place negotiation avoids its base transport's disposable sibling launch. Its automatic input fulfilment, header-mismatch effect retry and OAuth effect retries are disabled or bypassed through public options and token-only effect authentication.

A toolset candidate is cloned and validated in full before a synchronous publication. Registry identity binds an unbegun call to its exact revision; removed/replaced declarations produce known stale/not-executed outcomes. Already begun calls retain their original closure/client/schema. Next natural request captures the new declarations. No atomic zero-downtime upgrade or reversal of external effects is promised.

MCP `isError` remains a known failed outcome through the existing durable runtime. Transport loss remains unknown and is not replayed. Only text/structured content is delivered; unsupported media is explicitly reported. Deterministic installation-prefixed hashed names fit the existing 64-character tool contract. Tool selection is configuration, never an approval engine.

Protected settings reuse safe action handles and generic action groups. OAuth follows SDK discovery/PKCE, installation/server/issuer/registration-scoped credentials, one-use ephemeral state, issuer checking, bounded expiry and joined cancellation. Default loopback assumes the same browser computer. A different browser requires an explicitly configured provider-accepted HTTPS callback via an already existing user-managed route; no automatic network changes. Authorize is an explicit action, and model tools return safe operation receipts only.

Local launch uses a pinned installed executable with a minimal environment. The official transport owns MCP framing; a small POSIX supervisor owns only the server's spawned process group and joins/escalates shutdown. It is not a sandbox and cannot prevent deliberate reparenting/detaching by trusted code.

Tasks, Apps, sampling, automatic resources, prompts-to-skills and marketplace are out of scope. Synthetic protocol/auth fixtures are not live-account validation. See the package README and `test:mcp:e2e` for verification boundaries.
