# Feishu channel extension

Follow the repository root instructions. This package is an ordinary trusted Cordis
extension, not a server capability or a sandbox. Import only the public extension SDK
and the explicitly pinned official Feishu SDKs. Do not import server, life, persistence
or runtime internals.

- `src/index.ts` is the plugin entry/factory; `channel.ts` owns pairing and delivery.
- `sdk.ts` owns official registration/HTTP/WS adaptation; `store.ts` owns ordinary
  private inbox/delivery files within the generic installation directory.
- Credentials only use `context.credentials`; protected settings only use
  `registerSettings`. No vendor routes, global registries or reserved core IDs.
- No groups/multi-owner/Docs/user impersonation/media downloads/voice in this increment.
- Do not restore Channel auto batching/stale/dedup/retry paths without durable proof.
- No real accounts, grants, credentials or paid services during synthetic tests.
- Keep source-level and real tenant verification clearly separate in reports.
