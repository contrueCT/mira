# Feishu / Lark channel extension

An ordinary trusted Cordis extension using the public `@mira/extension-sdk` settings,
credentials, private directory, tools, ContextProvider, Event/Wake and cleanup contracts.
There is no Feishu server route, privileged built-in ID, second Host or second Mira.
It ships as source; installation and activation are explicit. Disable/remove uses the
same extension lifecycle as other authored or generated extensions.

## Install through the existing extension workflow

After the repository's pinned dependency installation, prepare an external workspace:

```sh
node scripts/prepare-extension-package.mts \
  /absolute/mira/packages/feishu-channel /absolute/new/feishu-workspace
```

This helper links only already-installed declared runtime dependencies, never installs
packages or executes their scripts. Authored source-tree symlinks are rejected before
writing the destination because flattening them can change Node import resolution.
Ordinary source files are required; declared dependency/pnpm links retain their existing
controlled topology. The resulting workspace has `entry.mjs`.
Use the existing `extension_stage` tool with that workspace and entry. Run the normal
artifact-test command against the returned digest, including a module-import smoke
check, then `extension_manage` install with the actual digest and activate. See the
extension-authoring skill for the content-bound test workflow. Installing is initially
disabled; activation with no stored app only registers settings/tools, without network
or credential reads. The generated artifact contains the selected dependency closure;
it does not depend on a mutable checkout at activation time.

A manual entry pointing to `packages/feishu-channel/src/index.ts` in an explicitly
configured extensions file is also supported. It is not the only installation route.

## Start from dialogue or generic extension settings

When the user asks to connect, the plugin's `feishu_connect` tool starts its declared
settings action through the same host runner. It returns an operation receipt and
instructions to open settings immediately; authorization URLs and credentials remain
only in protected settings. Repeated calls reuse the pending operation; its optional
`cancelOperationId` and the UI cancel button target that same operation. A saved app
reconnects without registration. A ready connection is reused. Unknown registration
outcomes block tool retries just as they block the settings button.

The framework supplies no Feishu-specific tool, route or automatic popup. The user
opens the existing settings panel to finish authorization and explicit pairing.

## Connect in the generic extension settings

1. Choose 飞书 or Lark. These are separate application/tenant identity domains.
2. Choose 扫码连接（创建应用） and open/scan the official authorization link. The action
   remains pending while polling; cancel stops accepting late results. App credentials are saved privately once registration returns, even if approval or
   connection verification still fails; reconnect can retry verification without creating
   another app. Cancelling does not delete an app already created. No secret is
   returned through the model or an ordinary tool result.
3. Confirm the application and requested scopes on the official service. Tenant
   policy can require approval/publication. The SDK cannot configure every backend
   setting: enable the bot, subscribe to `im.message.receive_v1` using **long connection**,
   and ensure the app is available to the intended owner.
4. Only `im:message.p2p_msg:readonly` and `im:message:send_as_bot` are requested. No Docs,
   Contacts, group-read or user-impersonation permissions are requested.
5. Generate a pairing code, send the displayed `/mira pair …` in the bot's private chat,
   inspect the candidate tenant/open-user/chat identity, then explicitly confirm it in
   Mira. The first sender does not automatically become the owner. Confirmation sends
   one test message. A verified connection and confirmed test send are required before
   the extension reports connected.

Manual fallback: create/publish a self-built app, enable its bot and the same minimum
scopes/event subscription, then save App ID and App Secret in the generic protected
settings and choose 验证手动配置并连接. App Secret is write-only and stored through the
host's installation-scoped credential API. It never belongs in extension JSON config,
Memory, Timeline, tool arguments or URLs.

Registration uses published `@larksuite/channel` **0.7.1** (`registerApp`) and
`@larksuiteoapi/node-sdk` **1.75.0**. Published versions were checked against npm, not
inferred from repository heads. Registration is explicit and uses `preset:false` with
only the listed scopes/event. It may still need tenant approval and platform setup.
No real account registration or live Feishu connectivity has been validated here.
Scope introspection is verified through the actual SDK API, but its permission
prerequisites still require an authorized real-tenant check; denial fails closed.

## Conversation and delivery

- Inbound: only the paired tenant + user open ID + private chat, from a human sender.
  Full source IDs, original timestamp, text and quote IDs are preserved. Other senders,
  bots and groups do not wake Mira. Unsupported media is an explicit text notice;
  this version does not fetch media or implement voice.
- Startup replay and newly arriving messages share the same state-write queue.
  A private inbox is saved before the normal durable Event/Wake receive. Stable identity
  includes the binding/app/domain and platform message ID. Restart flushes only that
  inbox into the existing deduplicating writer. It never replays model work itself.
- Outbound: `feishu_send_message` explicitly sends to the paired owner. Ordinary Web
  replies are not mirrored. Replies can reference one of the last 512 verified owner
  message IDs; older/unrecognized targets are refused rather than sent to another chat.
- Text is bounded to 100,000 UTF-8 bytes and split at code-point boundaries into ordered
  pieces of at most 6,000 bytes. Partial, not-started and unknown pieces are reported.
  Each piece's unknown intent is saved before HTTP; the same call never resumes or
  retries after an ambiguous effect, even after restart. No exactly-once network claim.
- The SDK refreshes tenant tokens normally. Effectful message create/reply calls have no
  automatic retry, reply fallback or Channel message splitting. Binding/reconnect is
  distinct from an explicit new test send.
- The private state file has a 2 MB bound. Capacity/storage failure stops intake or
  further sends with a visible failure rather than dropping queued evidence. Source
  code, Memory and artifact folders do not hold channel state.

## SDK reliability boundary

Channel 0.7.1's normal receiver applies in-memory dedup, stale rejection and batching;
its raw callback catches handler failures. Those behaviors can ACK before durable
Mira acceptance. This extension therefore uses the official node-sdk EventDispatcher
and WSClient for raw ingress, while retaining official Channel app registration.
The dispatcher awaits ingestion, and the official WS client responds with code 500
when ingestion rejects. The extension stops intake and reports the failure; platform
redelivery is still not guaranteed. Repair storage and reconcile missing messages.
Official reconnect lifecycle callback order is covered explicitly by synthetic tests.

Credentials use the host's private store. The extension owns an ordinary private JSON
state file for owner binding, pending inbox and delivery receipts. Trusted extension
code runs as the host OS user; these facilities are not a sandbox. Unbind clears local
credentials/binding; it does **not** delete the remote app or revoke tenant grants.
Disable retains local state for explicit re-enable. Remove follows generic uninstall
credential cleanup; retained historical private files are not silently deleted.

## Verification

- `tests/unit/feishu-sdk.test.mts`: actual SDK HTTP and EventDispatcher with synthetic
  responses, callback ordering, minimal registration options, no effectful replay.
- `tests/unit/feishu-channel.test.mts`: real private files + synthetic SDK, explicit
  pairing, identity rejection, durable replay, unknown outcomes and activation cleanup.
- `tests/unit/feishu-store.test.mts`: private modes, symlink/hardlink and path checks.
- `tests/unit/extension-package-preparation.test.mts`: ordinary dependency preparation.
- `tests/unit/feishu-generated-install.test.mts`: real prepare/stage/hash/test/install/
  activate/disable/re-enable/remove on the actual shipped package and dependency closure.

These are synthetic protocol and lifecycle tests, not a successful real-tenant login.

### 网页来源显示

本人入站消息与已确认发送的分段通过通用 `ExtensionEvent.message` 投影显示在同一网页时间线，时间旁显示小号“飞书 · 安装 ID · 收到/已发送”。真实发送者和“由扩展验证”保留在来源详情；显示方向不授予网页本人权限。每条显示复用稳定事件 ID，网页同步失败保留待投递证据，恢复时只补事件，不重发飞书。未知发送不会显示为已发送。普通模型 final 保留原样，不按相同文本猜测去重，因此不承诺完全镜像或绝无模型重复措辞。

Inbound disk/database work uses only the short state-write queue. Outbound HTTP runs
outside that queue, so a pending send does not delay durable reception. Unbind/reconnect
stop not-started tail pieces and drain the current request before changing the binding.
Cleanup retains unknown evidence for a request whose result arrives after retirement;
SDK HTTP requests have a 15-second timeout each, rather than holding cleanup indefinitely.


Authorization expiry comes from the official registration response (seconds). The
plugin hides an expired URL even before the SDK polling promise settles. After an
provider-expired/denied operation ends, the plugin-declared “授权过期后重新申请二维码” action
requests a new provider authorization; it never merely redraws the previous URL.
While an operation is pending, use the existing settings cancellation first. Cancellation
or network failure (including the SDK’s local polling deadline) may leave a remotely created app: a durable unknown-attempt marker
blocks another registration, including after restart. Check the official app console and
recover existing App ID/Secret with manual configuration. Only after confirming that no
app was created should the user explicitly unbind/reset and register again. A saved app
always uses reconnect, never registration. Local cancellation does not revoke remote apps.

SDK begin does not support request cancellation. The adapter retires its local wait
on abort or a 15-second begin deadline and suppresses late callbacks/results; this does not cancel or undo remote effects.


Reconnect/unbind cancellation is checked again after draining the current send and
before changing the binding or deleting credentials. Cancellation there restores a
fresh send controller for future calls and preserves the existing connection, owner
and receipts. Old queued calls retain their cancelled generation; neither unknown
requests nor unstarted message tails are replayed. Once the actual disconnect/reset
has begun, cancellation does not roll back completed effects; the connection status
reports the resulting state separately from the operation's cancellation receipt.
