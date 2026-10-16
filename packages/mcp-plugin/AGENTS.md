# MCP plugin

Follow root AGENTS. This is an ordinary extension consumer, not a core integration.

- Only public extension-sdk, pinned official MCP client and quiet pinned Ajv imports. No host/runtime/database imports, global manager, vendor routes or extra permission engine.
- One server per installation; normal artifact lifecycle and protected settings own configuration/auth.
- Preserve begun calls and stale old declarations. Pass exact toolDefinition; disable input autoFulfill and auth effect retries. Never turn lost transport into a known failure or replay.
- Secrets use installation credentials, never config/model/logs. OAuth listener stays loopback; HTTPS callbacks require existing explicit proxy. No network changes or real credentials in tests.
- Use official modern/legacy stdio and HTTP fixtures. Keep real PG/browser acceptance separate from offline tests. Read README for scope and commands.

- Header-mirroring tools (`x-mcp-header`) are excluded at public request seam before SDK logging; ordinary tools survive pagination. Quiet output-schema validator preserves dialect/format validation without console output.

- Preserve server tool names unchanged in model/UI/calls; no prefixes, hashes or alias mapping. Reject actual global collisions and invalid names, retaining the previous valid catalog. Connection actions use generic extension_manage settings operations, not per-instance control tools.
