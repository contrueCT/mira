# Feishu channel extension

Follow the repository root instructions. This package is an ordinary trusted Cordis
extension, not a server capability or a sandbox. Import only the public extension SDK
and the explicitly pinned official Feishu SDKs. Do not import server, life, persistence
or runtime internals.

- `src/index.ts` is the plugin entry/factory; `channel.ts` owns durable private-message ingestion, target resolution and delivery.
- `sdk.ts` owns official registration/HTTP/WS adaptation; `store.ts` owns ordinary
  private inbox JSON and per-call delivery rows in one SQLite database within the generic installation directory.
- Credentials only use `context.credentials`; protected settings only use
  `registerSettings`. No vendor routes, global registries or reserved core IDs.
- Default multi-person human private/group messages; every delivered human group message may wake Mira without @, while reply decisions remain with Mira. No owner pairing or implicit last-chat recipient. No Docs/user impersonation/media downloads/voice/bot-message loops.
- Do not restore Channel auto batching/stale/dedup/retry paths without durable proof.
- No real accounts, grants, credentials or paid services during synthetic tests.
- Keep source-level and real tenant verification clearly separate in reports.

- Built-in node:sqlite is plugin-local. Main ledger and bounded per-call receipts share one transactional CAS; no new core storage.
  Preserve permanent call identities/unknown evidence; compact published bodies only after durable Host acceptance.
  Pending publication queries are binding-scoped; never publish a retired binding into a new one.
  Keep legacy JSON evidence, require stopped-old-process upgrade, and never auto-replay unknown sends.

- ADR 0054: directory lookup uses app identity and complete bounded traversal; root fallback is separately server-checked when scope introspection is denied. Never auto-select from incomplete/ambiguous results.
- Incoming rows and outgoing receipts share the private SQLite CAS. ACK after durable ingress, enrich/freeze names before Host publication, retain per-message identity after body compaction. Stop old processes before schema-3 upgrades.
- ADR 0055: connection failures expose only fixed reasons and allowlisted missing permissions in existing protected settings. Group payload adds chatType/chatId; explicit chatId and reply references must agree, user targets cannot be combined with group replies. Keep all old send digests unchanged.
- ADR 0057: failures retain fixed safe operation/reason/message and bounded numeric API/HTTP codes in tool results, frozen inbound payloads and the ordinary ContextProvider/settings. No raw upstream errors, new Wake/retry or permission expansion. Persist per-part send diagnostics; a failed web publication never changes confirmed delivery or permits replay. Lifecycle cancellation and deliberate queue draining retain their original semantics.
