# Feishu / Lark channel extension

An ordinary trusted Cordis extension using `@mira/extension-sdk` settings,
credentials, private storage, tools, ContextProvider, Event/Wake and cleanup.
It uses the pinned official Node SDK directly; no CLI, MCP, vendor server route,
reserved core ID or second Mira loop. See [ADR 0054](../../docs/adr/0054-feishu-multi-recipient-plan.md).

## Install and connect

After the repository's pinned dependency installation, prepare an external workspace:

```sh
node scripts/prepare-extension-package.mts \
  /absolute/mira/packages/feishu-channel /absolute/new/feishu-workspace
```

The helper only prepares already-installed runtime dependencies. Stage `entry.mjs`
through `extension_stage`, run content-bound artifact tests including an import smoke
check, then install the actual digest with `extension_manage` and activate explicitly.
A manual entry pointing to the package's absolute `src/index.ts` is also supported.
Activation without a saved app only registers settings/tools; it does not connect.

In Settings → Extensions, choose 飞书 or Lark (separate identity domains). Use
扫码连接, or enter an existing App ID and protected App Secret and choose 连接已有应用.
`feishu_connect` starts the same settings runner and returns a safe operation receipt;
authorization URLs and credentials remain in protected settings. Tenant approval,
publication, bot capability and long-connection subscription to `im.message.receive_v1`
may still be needed. No pairing step or automatic test message is performed.

The base grants remain `im:message.p2p_msg:readonly` and `im:message:send_as_bot`.
Additional Contacts grants/data scope are explicit administrator configuration;
registration does not silently request more permissions. App Secret uses the generic
installation-scoped private credential API, never config, Memory or tool arguments.

Registration uses `@larksuite/channel@0.7.1` (`registerApp`, `preset:false`);
HTTP, EventDispatcher and WSClient use `@larksuiteoapi/node-sdk@1.75.0`.
The Channel pipeline's batching/stale filtering/in-memory dedup is not used.
An unknown/cancelled registration can have created a remote app: reconcile the
console and recover existing credentials before registering again. Local cancellation
or uninstall does not revoke remote apps or tenant grants.

## Model tools

- `feishu_search_users({query, offset?})`: read-only search of the app-visible
  directory; at most 20 matching `{name, openId, userId?}` rows per page and optional
  `nextOffset`. Each page is a new query; use its `complete` flag and explicit IDs.
- `feishu_send_message({text, recipientName?, recipientId?, recipientIdType?, replyToMessageId?})`:
  explicitly send as this application. Name and ID are mutually exclusive;
  `recipientIdType` defaults to `open_id` and also supports `user_id`.
  A recipient need not have messaged or paired with the bot first.
- `feishu_status` and `feishu_connect`: ordinary connection observation/action.

Examples:

```json
{"text":"明天下午三点开会。","recipientName":"张三"}
```

```json
{"text":"收到。","recipientId":"ou_example","recipientIdType":"open_id"}
```

```json
{"text":"我来处理。","replyToMessageId":"om_example"}
```

An exact name is sent only after a complete directory query has exactly one matching
user. Ambiguous/fuzzy names return candidates without sending; incomplete results
return `incomplete_search`. Clarification remains the model's natural decision.
No target and no reply ID returns `not_sent`; there is no implicit last-chat target.
A reply ID must be a retained inbound reference from the current app connection.
If an explicit recipient is also supplied, it must match that reference's sender;
`user_id` is resolved before comparison. Missing/mismatched references never fall back
to sending a new message. Old verified references remain readable without rewriting History.
Ordinary Web final replies are not automatically echoed. After a confirmed send the
model should avoid repeating the same body in its ordinary final reply.

## App identity directory lookup

The user-keyword search endpoint requires a user token. This plugin stays on app
identity: read Contacts scope, direct authorized users, department descendants and
paged direct members; deduplicate by open ID. If scope introspection is denied,
try root department `0` through the independently authorized member/department APIs.
Root access is not assumed. Failed/unsupported scope branches (including user groups
whose expansion is not implemented), missing names, repeated page tokens and budget
exhaustion produce incomplete results, never a unique-name automatic send.

Each search is bounded to 100 requests, 5000 unique users, 500 departments and 20 s.
No persistent full-directory cache is created. Names/IDs only are projected to the
model. Permission errors affect Contacts features, not explicit-ID sending.
Reading a user's name requires the relevant user-information/field permission;
listing departments/members and Contacts scopes can require different grants.
Set the application's Contacts data range explicitly; do not assume whole-company
access. A visible person can still be unreachable under app availability/tenant policy.
`user_id` also depends on the relevant employee-ID field permission.

## Multiple private senders and concise input

All human private messages received by the app can wake the same continuous Mira.
Groups and bot senders are ignored. A verified platform sender is not automatically
an owner or authority to act; external quoted/forwarded content remains external.

New payloads contain `senderName`, `senderOpenId`, `messageId`, `text` and a quote ID
only when present. The plugin keeps chat/tenant/application routing internally.
The generic Host envelope still supplies provenance, timestamp and History ID;
there is no Feishu-specific core renderer. Web shows ordinary text with the generic
small source label. Unsupported media is an explicit text notice, without downloading.
NUL/lone UTF-16 surrogates use reversible `textEncoding: "json-string"`; bounded,
well-formed previews do not replace the original payload.

WS callbacks ACK after private inbox persistence. A single recoverable consumer
looks up the sender name with a 1.5-second cancellation signal, freezes the exact
Wake, then submits to Host. Missing names use `姓名暂不可用` plus the actual open ID;
settings report degraded Contacts capability. Network lookup never holds the intake
state queue. Host failures retain pending rows and report error until explicit reconnect;
startup reconnect resumes durable delivery. Model runs never block the WS callback.
Duplicate message IDs compare the original digest; published duplicates do not query
names or publish another Wake. Frozen pending names/content survive restart unchanged.
Storage failure rejects the SDK handler (500 ACK) and stops intake; platform redelivery
is not guaranteed. Repair storage and reconcile missing messages.

## Delivery, storage and lifecycle

Text is bounded to 100000 UTF-8 bytes, split at code-point boundaries into ordered
pieces of at most 6000 bytes. Each call freezes its recipient and each piece's UUID
before HTTP. The same call ID returns its persisted result before any new name lookup;
changed content/target conflicts. Unknown sends and unstarted tails never auto-resume.
No exactly-once network guarantee is made. Confirmed outbound display Events record
the real recipient; repairing display delivery never resends HTTP.

Node 24's `node:sqlite` owns `feishu-state.json.sqlite`. Schema 3 adds per-message
`incoming` rows alongside the active ledger and per-call send receipts, sharing the
same short transactional revision CAS. Each value retains the existing 2 MB bound;
the database grows with permanent message/call identities and unresolved evidence.
Published inbound/outbound bodies are compacted only after Host durably accepts them.
Source digests and reply routes remain. No network I/O occurs in SQLite transactions.
Disk-full/busy/CAS failures remain visible and never authorize replay.

Stop **all old processes using the installation before upgrading**. Schema 1/2 upgrades
are transactional and retain current evidence; older binaries reject schema 3. Existing
JSON evidence remains byte-for-byte and old pending inboxes use their frozen format.
Previously consumed pairing messages remain consumed, but pairing actions/filtering
are removed. Existing authoritative History is not rewritten or cleared.

Reconnect/unbind cancel new work and drain current sends/inbox publication before
changing the app connection. Cancellation before the change preserves the connection;
old queued operations keep their cancelled signal. Disable retains state; remove uses
generic credential cleanup and retains private historical evidence. These facilities
run as the same trusted OS user and provide no sandbox or encryption boundary.

## Verification

- `tests/unit/feishu-directory.test.mts`: app scope/root fallback, paging/dedup,
  ambiguity/incomplete data, budgets and cancellation.
- `feishu-sdk`, `feishu-channel`, `feishu-dialogue`, `feishu-store` unit tests:
  actual SDK with synthetic HTTP/WS, multi-person routing, name/ID sends, immutable
  replay, private files/SQLite CAS, Unicode, lifecycle and durable ACK behavior.
- `feishu-generated-install`: actual prepare/stage/test/install/activate lifecycle.
- `tests/recovery/feishu-inbound.test.mts`: isolated PostgreSQL Host/Wake/History
  and restart recovery; `test:feishu:e2e`: real browser/HTTP/PG/runtime with synthetic
  model and Feishu transports. Neither proves live tenant WebSocket connectivity.

A separately authorized raw HTTP probe found a unique named user through root/child
member lists, sent by open ID as the app, and the user confirmed receipt. This did not
validate the modified plugin's live WebSocket/name lookup or every tenant's permissions.
No live credentials or personal directory records are included in the repository.
