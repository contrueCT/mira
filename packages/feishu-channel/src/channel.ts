import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext, ExtensionEvent, ExtensionWake, ExtensionConnectionStatus, Json } from '@mira/extension-sdk';
import { diagnose, failure, readFailure, FeishuFailureError, type FeishuFailure, type FeishuFailureReason, type FeishuOperation } from './diagnostics.ts';
import { FeishuPrivateStore, FeishuStoreError } from './store.ts';
import { FEISHU_GROUP_SCOPE, FEISHU_REQUIRED_SCOPES, FeishuSdkError } from './sdk.ts';
import type { FeishuSdk, FeishuCredentials, FeishuIncomingText } from './sdk.ts';
import { normalizedName, type FeishuUser } from './directory.ts';

type Owner = { tenantKey: string; senderOpenId: string; chatId: string };
type Part = { uuid: string; status: 'not_started' | 'unknown' | 'sent' | 'rejected'; messageId?: string; publication?: ExtensionEvent; published?: boolean; failure?: FeishuFailure };
type SendArgs = { text: string; recipientName?: string; recipientId?: string; recipientIdType?: 'open_id' | 'user_id'; chatId?: string; replyToMessageId?: string };
type Target = { recipientId?: string; recipientIdType?: 'open_id' | 'user_id'; chatId?: string; name?: string };
type SendResult = { status: 'sent' | 'unknown' | 'partial' | 'not_sent'; messageIds?: string[]; sentParts?: number; totalParts?: number; reason?: string; recipient?: Target; candidates?: FeishuUser[]; diagnostic?: FeishuFailure; diagnostics?: FeishuFailure[]; publicationFailure?: FeishuFailure };
type Receipt = { digest: string; parts: Part[]; connectionId?: string; target?: Target };
type IncomingReceipt = { digest: string; reference: FeishuIncomingText; wake?: ExtensionWake; delivered: boolean };
interface Stored {
  version: 1; registrationUnknown?: boolean; connectionId: string; app: { appId: string; domain: 'feishu' | 'lark' } | null;
  owner: Owner | null; pairingMessageId?: string; inbox: ExtensionWake[]; recentMessages: string[]; sends: Record<string, Receipt>;
}
const initial = (): Stored => ({ version: 1, connectionId: randomUUID(), app: null, owner: null, inbox: [], recentMessages: [], sends: {} });
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function stored(value: unknown): Stored {
  if (value === null) return initial();
  if (!object(value) || value.version !== 1 || !validId(value.connectionId) || !('app' in value) || !('owner' in value)
    || (value.app !== null && (!object(value.app) || !validId(value.app.appId) || !['feishu', 'lark'].includes(String(value.app.domain))))
    || (value.owner !== null && (!object(value.owner) || !validId(value.owner.tenantKey) || !validId(value.owner.senderOpenId) || !validId(value.owner.chatId)))
    || (value.registrationUnknown !== undefined && typeof value.registrationUnknown !== 'boolean') || (value.pairingMessageId !== undefined && !validId(value.pairingMessageId)) || !Array.isArray(value.inbox) || !Array.isArray(value.recentMessages) || !value.recentMessages.every(validId) || !object(value.sends)) throw new Error('Private Feishu state is invalid; it was not replaced');
  for (const item of value.inbox) if (!object(item) || !validId(item.id) || !object(item.event) || !validId(item.event.id) || item.event.type !== 'feishu.owner_message' || typeof item.event.occurredAt !== 'string' || !Number.isFinite(Date.parse(item.event.occurredAt))) throw new Error('Private Feishu state is invalid');
  for (const receipt of Object.values(value.sends)) storedReceipt(receipt);
  return value as unknown as Stored;
}
function storedReceipt(value: unknown): Receipt {
  if (!object(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 17
    || (value.connectionId !== undefined && !validId(value.connectionId))
    || value.parts.some(part => !object(part) || !validId(part.uuid) || !['not_started', 'unknown', 'sent', 'rejected'].includes(String(part.status))
      || (part.messageId !== undefined && !validId(part.messageId)) || (part.published !== undefined && typeof part.published !== 'boolean') || (part.failure !== undefined && !readFailure(part.failure)))) throw new Error('Private Feishu receipt is invalid; it was not replaced');
  if (value.target !== undefined && (!object(value.target) || (!validId(value.target.recipientId) && !validId(value.target.chatId))
    || (value.target.recipientIdType !== undefined && !['open_id', 'user_id'].includes(String(value.target.recipientIdType))))) throw new Error('Private Feishu target is invalid');
  return value as unknown as Receipt;
}
function incomingReceipt(value: unknown): IncomingReceipt {
  if (!object(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest) || typeof value.delivered !== 'boolean' || !object(value.reference)
    || !validId(value.reference.messageId) || !validId(value.reference.senderOpenId) || !validId(value.reference.chatId)
    || typeof value.reference.text !== 'string' || typeof value.reference.createdAt !== 'string') throw new Error('Private Feishu inbox is invalid');
  if (value.wake !== undefined && (!object(value.wake) || !validId(value.wake.id) || !object(value.wake.event) || value.wake.event.id !== value.wake.id)) throw new Error('Private Feishu frozen input is invalid');
  return value as unknown as IncomingReceipt;
}
const hasPending = (receipt: Receipt) => receipt.parts.some(part => part.status === 'sent' && !!part.publication && !part.published);
function compactReceipt(receipt: Receipt): Receipt {
  return { ...receipt, parts: receipt.parts.map(part => { if (!part.published) return part; const { publication: _publication, ...evidence } = part; return evidence; }) };
}
const validProjectionText = (text: string) => text.length > 0 && text.length <= 100_000 && text.isWellFormed() && !/[\u0000\u0008\u000b\u000c]/u.test(text);
/** PostgreSQL json extraction cannot represent NUL or lone UTF-16 surrogates. */
function preservedText(text: string): { text: string; textEncoding?: 'json-string' } {
  return text.includes('\u0000') || !text.isWellFormed() ? { text: JSON.stringify(text), textEncoding: 'json-string' } : { text };
}
/** Host-safe display only. The immutable payload retains a lossless original representation. */
function preview(text: string): string {
  if (validProjectionText(text)) return text;
  const header = '[Feishu text preview; original text is preserved in event payload]\n';
  const sanitized = text.toWellFormed().replace(/[\u0000\u0008\u000b\u000c]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const suffix = sanitized.length > 100_000 - header.length ? '\n[Preview truncated]' : '';
  const budget = 100_000 - header.length - suffix.length;
  let body = sanitized.slice(0, budget);
  if (body.length && /[\ud800-\udbff]/u.test(body.at(-1)!)) body = body.slice(0, -1);
  return header + body + suffix;
}
function projectedWake(wake: ExtensionWake): ExtensionWake {
  const payload = wake.event.payload;
  if (!object(payload) || typeof payload.text !== 'string' || !wake.event.message) return wake;
  const original: unknown = payload.textEncoding === 'json-string' ? JSON.parse(payload.text) : payload.text;
  if (typeof original !== 'string') throw new Error('Private Feishu text encoding is invalid');
  const preserved = preservedText(original); const display = preview(original);
  if (payload.text === preserved.text && payload.textEncoding === preserved.textEncoding && wake.event.message.text === display) return wake;
  const { textEncoding: _encoding, ...fields } = payload;
  return { ...wake, event: { ...wake.event, payload: { ...fields, ...preserved }, message: { ...wake.event.message, text: display } } };
}
/** Per-activation state. Identity, target resolution and delivery stay in this extension. */
export class FeishuChannel {
  readonly #context: ExtensionContext;
  readonly #sdk: FeishuSdk;
  readonly #config: { domain: 'feishu' | 'lark'; appId: string };
  readonly #store: FeishuPrivateStore<Stored> | null;
  #data = initial();
  #storageReady = false;
  #authorizationRetry = false;
  #connection: Awaited<ReturnType<FeishuSdk['connect']>> | undefined;
  #credentials: FeishuCredentials | undefined;
  #serial: Promise<unknown> = Promise.resolve();
  #sending: Promise<unknown> = Promise.resolve();
  #sendAbort = new AbortController();
  #closed = false;
  #epoch = 0;
  #ready = false;
  #state: ExtensionConnectionStatus['state'] = 'unconfigured';
  #error: string | null = null;
  #errorCode: NonNullable<ExtensionConnectionStatus['code']> = 'unknown';
  #groupReception = false;
  #authorization: { url: string; expiresAt: string } | null = null;
  #drain: Promise<void> | undefined;
  #drainRequested = false;
  #receiveAbort = new AbortController();
  #receiveFailed = false;
  #directoryIssue: string | null = null;
  readonly #failures = new Map<FeishuOperation, FeishuFailure>();
  readonly #abort = new AbortController();
  constructor(context: ExtensionContext, config: Json, sdk: FeishuSdk) {
    this.#context = context; this.#sdk = sdk;
    const fields = object(config) ? config : {};
    this.#config = { domain: fields.domain === 'lark' ? 'lark' : 'feishu', appId: typeof fields.appId === 'string' ? fields.appId.trim() : '' };
    this.#store = context.privateDirectory ? new FeishuPrivateStore(path.join(context.privateDirectory, 'feishu-state.json'), fileURLToPath(new URL('../../../', import.meta.url))) : null;
  }
  register(): void {
    const actions = this.#context.registerSettings({
      fields: [ { key: 'domain', label: '服务', type: 'select', options: [{ value: 'feishu', label: '飞书（中国）' }, { value: 'lark', label: 'Lark（国际）' }] },
        { key: 'appId', label: '手动配置 App ID（扫码连接可留空）', type: 'text' }, { key: 'appSecret', label: '手动配置 App Secret', type: 'secret' } ],
      actions: [
        { id: 'register', label: '扫码连接', execute: ({ signal }) => this.#register(signal) },
        { id: 'refresh_authorization', label: '重新申请授权', execute: ({ signal }) => this.#register(signal) },
        { id: 'connect', label: '连接已有应用', execute: ({ signal }) => this.#attemptConnection(signal, () => this.#data.app ? this.#changeConnection(signal, async () => { await this.#disconnect(); await this.#connect(signal); }) : this.#queue(() => this.#manual(signal))) },
        { id: 'reconnect', group: 'secondary', label: '重新连接', execute: ({ signal }) => this.#attemptConnection(signal, () => this.#changeConnection(signal, async () => { await this.#disconnect(); await this.#connect(signal); })) },
        { id: 'unbind', group: 'secondary', label: '解绑并清除本地凭据', execute: ({ signal }) => this.#maintenance(signal, () => this.#changeConnection(signal, async () => {
          await this.#disconnect(); await this.#credential(() => this.#context.credentials.delete('appSecret')); await this.#save(initial()); this.#failures.clear(); this.#directoryIssue = null; this.#storageReady = true; this.#authorizationRetry = false; this.#credentials = undefined; this.#error = null; this.#state = 'unconfigured';
        })) },
      ], status: () => this.status(),
    });
    this.#context.registerTool({ name: 'feishu_connect', mainOnly: true, description: 'Start this plugin’s connection action after the user asks to connect Feishu/Lark. Returns immediately while official authorization remains in this extension’s protected settings. Reuses the same settings operation and cancellation; never returns credentials or provider URLs. An unknown registration must be reconciled in settings, not retried. Optional cancelOperationId cancels exactly that operation locally, without revoking remote effects.',
      parameters: { type: 'object', properties: { cancelOperationId: { type: 'string' } }, additionalProperties: false },
      execute: async (args, { signal }) => {
        signal.throwIfAborted();
        if (!object(args) || (args.cancelOperationId !== undefined && !validId(args.cancelOperationId))) return { text: 'Invalid connection arguments' };
        if (typeof args.cancelOperationId === 'string') { await actions.cancel(args.cancelOperationId); return { text: '已请求取消本次本地连接操作。请在扩展设置核对结果；取消不撤销远端已创建的应用。' }; }
        const current = await actions.current(); signal.throwIfAborted();
        const guidance = '请打开设置 → 扩展 → 本扩展的连接设置，查看官方授权二维码或链接，完成授权或连接已有应用。';
        if (current?.state === 'pending') return { text: JSON.stringify({ operation: current, instruction: guidance }) };
        if (this.#data.registrationUnknown && !this.#data.app) return { text: '上次注册结果未知，未重新申请。请在扩展设置核对官方后台并恢复已有应用，避免重复创建。' };
        if (this.#ready) return { text: JSON.stringify({ state: this.#state, instruction: '已有连接，无需重复授权。' }) };
        const operation = await actions.start(this.#data.app || this.#config.appId ? 'connect' : this.#authorizationRetry ? 'refresh_authorization' : 'register');
        return { text: JSON.stringify({ operation, instruction: guidance }) };
      } });
    this.#context.registerTool({ name: 'feishu_status', description: 'Read whether this ordinary Feishu/Lark extension is connected. Use feishu_connect to start this plugin’s settings operation when the user requests connection. Credentials are only displayed there.', parameters: { type: 'object', additionalProperties: false }, execute: async () => ({ text: JSON.stringify(this.#observation()) }) });
    this.#context.registerTool({ name: 'feishu_search_users', description: 'Find people by name in this app’s visible directory. Returns a bounded page of name/openId pairs. complete=false means uniqueness is unproven; never guess a recipient from partial results. No user impersonation.',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 100 }, offset: { type: 'integer', minimum: 0, maximum: 5000 } }, required: ['query'], additionalProperties: false },
      execute: async (args, { signal }) => {
        if (!object(args) || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 100 || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 5000))) return { text: 'Invalid user search arguments', isError: true };
        if (!this.#credentials) return { text: 'Connect the Feishu app first.', isError: true };
        const epoch = this.#epoch; const combined = AbortSignal.any([signal, this.#abort.signal, this.#sendAbort.signal]);
        let result;
        try { result = await this.#sdk.searchUsers(this.#credentials, args.query, combined); }
        catch (error) { combined.throwIfAborted(); const diagnostic = this.#remember('directory_search', error, 'directory_failed'); return { text: JSON.stringify({ complete: false, users: [], diagnostic }), isError: true }; }
        if (this.#closed || epoch !== this.#epoch) return { text: 'Connection changed; search result discarded.', isError: true };
        this.#directoryIssue = result.complete ? null : result.reason ?? 'directory_failed';
        if (result.complete) this.#failures.delete('directory_search');
        else this.#remember('directory_search', result.diagnostic ? new FeishuFailureError(result.diagnostic) : undefined, 'directory_failed');
        const offset = Number(args.offset ?? 0); const page = { ...result, users: result.users.slice(offset, offset + 20), ...(result.users.length > offset + 20 ? { nextOffset: offset + 20 } : {}) };
        return { text: JSON.stringify(page), details: page, isError: !result.complete };
      } });
    this.#context.registerTool({ name: 'feishu_send_message', mainOnly: true, description: 'Send text as this Feishu/Lark app. Choose recipientName (one exact match in a complete directory), recipientId (open_id or user_id), chatId (explicit conversation, including groups), or replyToMessageId from an inbound message. Reply IDs select the original conversation; an additional chatId must match it. A user recipient cannot be combined with a group reply. Clarify ambiguous names. No implicit last-chat target. Receiving any private/group message does not require replying: decide whether a reply is useful. Ordinary Web replies are not echoed; after a confirmed send avoid repeating the body. Partial/unknown sends are never automatically replayed. publicationFailure means confirmed delivery awaiting Web sync; do not resend.',
      parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, recipientName: { type: 'string', minLength: 1, maxLength: 100 }, recipientId: { type: 'string', minLength: 1, maxLength: 512 }, recipientIdType: { type: 'string', enum: ['open_id', 'user_id'] }, chatId: { type: 'string', minLength: 1, maxLength: 512 }, replyToMessageId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['text'], additionalProperties: false },
      execute: async (args, { callId, signal }) => {
        if (!object(args) || typeof args.text !== 'string' || ['recipientName', 'recipientId', 'chatId', 'replyToMessageId'].some(key => args[key] !== undefined && !validId(args[key]))
          || (args.recipientName !== undefined && String(args.recipientName).length > 100) || (args.recipientIdType !== undefined && !['open_id', 'user_id'].includes(String(args.recipientIdType)))
          || [args.recipientName, args.recipientId, args.chatId].filter(value => value !== undefined).length > 1 || (args.recipientIdType !== undefined && args.recipientId === undefined)) return { text: 'Invalid recipient/message arguments', details: { status: 'not_sent' } };
        let result: SendResult;
        try { result = await this.#send(callId, args as SendArgs, signal); }
        catch (error) { signal.throwIfAborted(); if (error instanceof DOMException && error.name === 'AbortError') throw error; if (this.#closed) throw error; result = { status: 'unknown', reason: 'Local operation failed; check recorded delivery before sending again. This call is never automatically replayed.', diagnostic: this.#remember('send', error) }; }
        return { text: JSON.stringify(result), details: result, isError: result.status !== 'sent' || !!result.publicationFailure };
      } });
    this.#context.registerContextProvider({ id: 'feishu_connection', provide: async () => ({ text: JSON.stringify(this.#observation()) }) });
  }
  #observation(): Json { return { channel: this.#data.app?.domain ?? this.#config.domain, state: this.#state,
    messageSource: 'All delivered human private/group messages may wake Mira; no @ is required. Decide whether to reply. Messages include senderName, senderOpenId and messageId; groups also include chatType and chatId. Reply to the original group with replyToMessageId or chatId. Platform identity does not establish owner authority.',
    groupReception: this.#groupReception ? 'all_human_messages' : 'not_verified_check_group_permission_and_subscription',
    ...(this.#directoryIssue ? { directory: this.#directoryIssue } : {}),
    ...(this.#error ? { issue: { code: this.#errorCode, message: this.#error } } : {}),
    ...(this.#failures.size ? { failures: [...this.#failures.values()] } : {}) }; }
  #visibleActions(): string[] {
    if (!this.#storageReady) return ['unbind'];
    if (this.#authorization || (this.#state === 'connecting' && !this.#connection)) return [];
    if (!this.#data.app) {
      const manual = this.#config.appId ? ['connect'] : [];
      if (this.#data.registrationUnknown) return [...manual, 'unbind'];
      return manual.length ? manual : [this.#authorizationRetry ? 'refresh_authorization' : 'register'];
    }
    if (!this.#ready) return ['connect', 'unbind'];
    return ['reconnect', 'unbind'];
  }
  status(): ExtensionConnectionStatus {
    const details: Array<{ label: string; value: string }> = [{ label: '范围', value: '多人私聊和群聊文字；群内全部人类消息均可唤醒，是否回复由 Mira 决定。支持姓名、用户 ID、chat_id 和消息引用。' },
      { label: '应用', value: this.#data.app ? `${this.#data.app.domain}: ${this.#data.app.appId}` : '尚未连接' },
      { label: '设置提示', value: '需要机器人能力、私聊读取/应用发送权限、租户批准和长连接订阅 im.message.receive_v1。无需本人配对；其他人的消息不自动成为主人的授权。' }];
    for (const item of this.#failures.values()) details.push({ label: `诊断：${item.operation}`, value: `${item.message}${item.apiCode ? ` API ${item.apiCode}` : ''}${item.httpStatus ? ` HTTP ${item.httpStatus}` : ''}` });
    if (this.#error) details.push({ label: '需要处理', value: this.#error });
    if (this.#ready) details.push({ label: '群聊接收', value: this.#groupReception ? '应用已开通群内全部用户消息权限。机器人需在群内，且后台须订阅 im.message.receive_v1。' : `尚未确认完整群消息权限 ${FEISHU_GROUP_SCOPE}；私聊连接可继续。只能收到飞书按现有权限和事件订阅实际推送的群消息。` });
    if (this.#directoryIssue) details.push({ label: '姓名查询', value: '姓名或通讯录查询未完成；请检查应用的用户基本信息、部门成员权限及通讯录范围。按 ID 发送不依赖姓名查询。' });
    if (this.#data.registrationUnknown && !this.#data.app && this.#state !== 'connecting' && this.#state !== 'pending') details.push({ label: '注册结果待核对', value: '上次注册可能已创建应用。请先到官方后台核对，已有应用用手动配置恢复；确认未创建后才可解绑清除本地记录并重新申请。' });
    const authorization = this.#authorization && Date.parse(this.#authorization.expiresAt) > Date.now() ? this.#authorization : null;
    if (this.#authorization && !authorization) details.push({ label: '授权', value: '二维码已过期。等待本次操作结束后点击“重新申请授权”；仍在处理时可先取消。' });
    if (this.#authorization) details.push({ label: '授权链接有效期', value: this.#authorization.expiresAt });
    return { state: this.#state, visibleActions: this.#visibleActions(), ...(this.#error ? { code: this.#errorCode } : {}), details,
      ...(authorization ? { authorization: { url: authorization.url, label: `在${this.#config.domain === 'feishu' ? '飞书' : 'Lark'}官方页面扫码确认应用与最小权限`, qr: true } } : {}) };
  }
  #remember(operation: FeishuOperation, error: unknown, fallback: FeishuFailureReason = 'unknown'): FeishuFailure {
    const diagnostic = error instanceof FeishuStoreError ? failure(operation, error.code === 'busy' ? 'storage_busy' : error.code === 'conflict' ? 'storage_conflict' : 'storage_unavailable') : diagnose(operation, error, fallback);
    this.#failures.set(operation, diagnostic); return diagnostic;
  }
  async initialize(): Promise<void> {
    if (!this.#store) { this.#remember('storage', undefined, 'storage_unavailable'); this.#state = 'error'; this.#error = '需要持久扩展安装身份和私有目录，尚未连接或读取凭据。'; return; }
    try { await this.#queue(async () => { const loaded = await this.#store!.load(); this.#data = stored(loaded); if (Object.keys(this.#data.sends).length) await this.#save(this.#data); this.#storageReady = true; if (this.#data.registrationUnknown && !this.#data.app) this.#state = 'error'; if (this.#data.app) await this.#connect(this.#abort.signal); }); }
    catch (error) { if (this.#storageReady) this.#connectionFailed(error); else { this.#remember('storage', error, 'storage_unavailable'); this.#state = 'error'; this.#error = '私有状态不可用，原状态未被清空。请检查本地存储。'; } }
  }
  #connectionFailed(error: unknown): void {
    this.#remember('connection', error);
    this.#state = 'error'; this.#errorCode = 'configuration';
    const reason = error instanceof FeishuSdkError ? error.reason : undefined;
    const scopes = error instanceof FeishuSdkError ? FEISHU_REQUIRED_SCOPES.filter(scope => error.missingScopes.includes(scope)) : [];
    if (reason === 'missing_permissions' && scopes.length) this.#error = `缺少已生效的应用身份权限：${scopes.join('、')}。请在飞书/Lark 后台开通，并完成所需发布与租户审批后重新连接。`;
    else if (reason === 'storage_unavailable') this.#error = '私有状态尚未安全读取，连接不能覆盖原记录。请检查本地存储，或在核对后显式解绑重置。';
    else if (reason === 'credentials_missing') this.#error = '请先保存 App ID 和 App Secret，再连接已有应用。';
    else if (reason === 'token_rejected') { this.#errorCode = 'authentication'; this.#error = '飞书/Lark 拒绝签发应用令牌。请核对 App ID、App Secret、服务区域和应用状态。'; }
    else if (reason === 'bot_unavailable') this.#error = '无法验证机器人身份。请检查应用已启用机器人能力、已发布，且应用状态正常。';
    else if (reason === 'scope_query_failed') this.#error = '无法读取应用已生效的权限列表，尚未继续连接。请检查应用状态、权限管理和租户审批后重试。';
    else if (reason === 'network') { this.#errorCode = 'network'; this.#error = '连接飞书/Lark API 失败或超时。请检查服务器出站网络、DNS、代理及 TLS 证书。'; }
    else if (reason === 'connection_timeout' || reason === 'websocket_failed') { this.#errorCode = 'network'; this.#error = `${reason === 'connection_timeout' ? 'WebSocket 长连接在 15 秒内未就绪' : 'WebSocket 长连接失败'}。请检查服务器网络，并确认飞书/Lark 后台已选择长连接、订阅 im.message.receive_v1，配置已生效。`; }
    else { this.#errorCode = 'unknown'; this.#error = '飞书/Lark 连接未完成。请检查私有存储、应用凭证、机器人权限和后台事件订阅后重试。'; }
  }
  async #attemptConnection(signal: AbortSignal, run: () => Promise<void>): Promise<void> {
    this.#error = null; this.#errorCode = 'unknown';
    try { await run(); this.#failures.delete('connection'); }
    catch (error) {
      if (!this.#closed && !signal.aborted) this.#connectionFailed(error);
      else if (!this.#closed) { this.#settle(); this.#error = null; }
      throw new Error(signal.aborted ? 'Feishu connection cancelled' : `Feishu connection was not verified: ${this.#error ?? ''}`);
    }
  }
  #queue<T>(action: () => Promise<T>): Promise<T> {
    // Release the queue after rejection; the originating caller still observes its error.
    const operation = this.#serial.catch(() => {}).then(async () => { if (this.#closed) throw new Error('Feishu extension is stopped'); return action(); }); this.#serial = operation; return operation;
  }
  async #save(data: Stored): Promise<void> {
    if (!this.#store || this.#closed) throw new Error('Feishu private storage unavailable');
    const receipts = Object.fromEntries(Object.entries(data.sends).map(([callId, value]) => { const receipt = compactReceipt({ ...value, connectionId: value.connectionId ?? data.connectionId }); return [callId, { value: receipt, pending: hasPending(receipt), bindingId: receipt.connectionId! }]; }));
    const next = { ...data, sends: {} }; await this.#store.save(next, receipts); this.#data = next;
  }
  async #saveReceipt(callId: string, value: Receipt): Promise<Receipt> {
    if (!this.#store || this.#closed) throw new Error('Feishu private storage unavailable');
    const receipt = compactReceipt(value); await this.#store.saveReceipt(callId, receipt, hasPending(receipt), receipt.connectionId!); return receipt;
  }
  async #credential<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) { throw new FeishuFailureError(this.#remember('storage', error, 'storage_unavailable')); }
  }
  async #maintenance(signal: AbortSignal, run: () => Promise<void>): Promise<void> {
    try { await run(); } catch (error) {
      signal.throwIfAborted(); if (this.#closed) throw error;
      throw new FeishuFailureError(this.#remember(error instanceof FeishuFailureError ? error.diagnostic.operation : 'storage', error, 'storage_unavailable'));
    }
  }
  async #readCredentials(): Promise<FeishuCredentials> {
    if (!this.#data.app) throw new Error('No Feishu app is configured');
    const appSecret = await this.#credential(() => this.#context.credentials.get('appSecret'));
    if (!appSecret) throw new FeishuSdkError('verification_failed', { reason: 'credentials_missing' });
    return { ...this.#data.app, appSecret };
  }
  async #manual(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#storageReady) throw new FeishuSdkError('verification_failed', { reason: 'storage_unavailable' });
    if (this.#data.app) throw new Error('请先解绑现有应用，再切换应用或手动配置');
    const appSecret = await this.#credential(() => this.#context.credentials.get('appSecret'));
    if (!validId(this.#config.appId) || !appSecret) throw new FeishuSdkError('verification_failed', { reason: 'credentials_missing' });
    const credentials = { appId: this.#config.appId, appSecret, domain: this.#config.domain };
    await this.#sdk.verify(credentials); signal.throwIfAborted();
    await this.#save({ ...initial(), app: { appId: credentials.appId, domain: credentials.domain } }); await this.#connect(signal);
  }
  async #register(signal: AbortSignal): Promise<void> {
    if (!this.#store || !this.#storageReady || this.#closed || this.#data.app || this.#data.registrationUnknown || this.#authorization) throw new Error('请先解绑或取消现有应用连接');
    const combined = AbortSignal.any([signal, this.#abort.signal]); const epoch = this.#epoch;
    this.#state = 'connecting'; this.#error = null; this.#authorizationRetry = false;
    try {
      await this.#queue(async () => { combined.throwIfAborted(); if (this.#data.registrationUnknown || this.#data.app) throw new Error('Registration already attempted'); await this.#save({ ...structuredClone(this.#data), registrationUnknown: true }); });
      const credentials = await this.#sdk.register({ domain: this.#config.domain, signal: combined,
        onQRCode: ({ url, expireIn }) => {
          if (combined.aborted || this.#closed || epoch !== this.#epoch) return;
          if (!Number.isFinite(expireIn) || expireIn < 0 || expireIn > 86_400) throw new Error('Invalid authorization lifetime');
          const parsed = new URL(url); const suffix = this.#config.domain === 'feishu' ? 'feishu.cn' : 'larksuite.com';
          if (parsed.protocol !== 'https:' || !(parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`)) || parsed.username || parsed.password) throw new Error('Unexpected authorization domain');
          this.#authorization = { url, expiresAt: new Date(Date.now() + Math.max(0, expireIn) * 1000).toISOString() }; this.#state = 'pending';
        }, onStatus: () => {} });
      combined.throwIfAborted();
      await this.#queue(async () => { combined.throwIfAborted();
        await this.#credential(() => this.#context.credentials.set('appSecret', credentials.appSecret));
        await this.#save({ ...initial(), app: { appId: credentials.appId, domain: credentials.domain } });
        await this.#connect(combined);
      });
    } catch (error) {
      if (!this.#closed && error instanceof FeishuSdkError && (error.code === 'registration_expired' || error.code === 'registration_denied') && !combined.aborted) await this.#queue(async () => { await this.#save({ ...structuredClone(this.#data), registrationUnknown: false }); this.#authorizationRetry = true; });
      if (!this.#closed) {
        if (this.#data.app && !combined.aborted) this.#connectionFailed(error);
        else { this.#state = this.#data.registrationUnknown && !this.#data.app ? 'error' : combined.aborted ? (this.#data.app ? 'disconnected' : 'unconfigured') : 'error'; this.#error = error instanceof FeishuSdkError && error.code === 'registration_expired' ? '授权已过期，旧二维码不可再用。点击“重新申请授权”获取新的授权请求；如已创建应用，请先用手动配置恢复。' : error instanceof FeishuSdkError && error.code === 'registration_denied' ? '授权被拒绝。本次操作已结束，可确认权限后重新申请。' : this.#data.registrationUnknown && !this.#data.app ? '注册结果未知或已取消。请先核对官方后台，避免重复创建应用；取消本地操作不撤销已创建的远端应用。' : combined.aborted ? null : '扫码注册、应用权限或连接验证未完成。请检查租户审批，也可使用手动配置。'; }
      }
      if (!combined.aborted && !this.#closed) this.#remember('registration', error, 'registration_unknown');
      throw new Error(combined.aborted ? 'Feishu registration cancelled' : 'Feishu registration was not verified');
    } finally { this.#authorization = null; }
  }
  async #connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (!this.#data.app) throw new Error('先连接应用');
    const epoch = ++this.#epoch; this.#state = 'connecting'; this.#error = null;
    try {
      const credentials = await this.#readCredentials();
      const connection = await this.#sdk.connect(credentials, { onMessage: message => this.#queue(async () => {
        if (epoch !== this.#epoch || this.#closed) throw new Error('Retired Feishu connection');
        try { await this.#receive(message); } catch (error) { throw new FeishuFailureError(this.#remember('receive', error, 'storage_unavailable')); }
      }), onDiagnostic: diagnostic => {
        if (epoch !== this.#epoch || this.#closed) return;
        this.#remember(diagnostic.operation, new FeishuFailureError(diagnostic));
      }, onState: (state, diagnostic) => {
        if (epoch !== this.#epoch || this.#closed) return;
        if (state === 'unsupported_message') { if (diagnostic) this.#remember('receive', new FeishuFailureError(diagnostic)); return; }
        this.#ready = state === 'connected';
        if (this.#ready) { this.#failures.delete('connection'); if (!['receive', 'inbox_delivery', 'outbound_publication', 'storage'].some(operation => this.#failures.has(operation as FeishuOperation))) this.#error = null; this.#settle(); }
        else if (state === 'receive_failed') { this.#remember('receive', diagnostic ? new FeishuFailureError(diagnostic) : undefined, 'storage_unavailable'); this.#state = 'error'; this.#error = '消息接收失败，连接已停止；请查看接收诊断，修复后重连并核对缺失消息。'; }
        else if (state === 'failed') this.#connectionFailed(new FeishuSdkError('connection_failed', { reason: 'websocket_failed', ...(diagnostic ? { failure: diagnostic } : {}) }));
        else { if (diagnostic) this.#remember('connection', new FeishuFailureError(diagnostic)); this.#state = state === 'closed' ? 'disconnected' : 'connecting'; }
      } });
      if (signal.aborted || this.#closed || epoch !== this.#epoch) { await connection.close(); signal.throwIfAborted(); throw new Error('Connection retired'); }
      this.#failures.delete('connection'); this.#failures.delete('registration'); this.#failures.delete('storage');
      this.#credentials = credentials; this.#connection = connection; this.#sendAbort = new AbortController(); this.#ready = connection.state() === 'connected';
      this.#groupReception = connection.scopes?.includes(FEISHU_GROUP_SCOPE) === true;
      await this.#flush(); await this.#flushPublications(); this.#receiveFailed = false; this.#receiveAbort = new AbortController(); this.#settle(); this.#startDrain();
    } catch (error) { this.#ready = false; this.#connectionFailed(error); throw error; }
  }
  async #disconnect(): Promise<void> {
    this.#epoch++; this.#ready = false; this.#groupReception = false; const connection = this.#connection; this.#connection = undefined; this.#credentials = undefined; this.#settle();
    try { await connection?.close(); } catch (error) { throw new FeishuFailureError(this.#remember('connection', error, 'websocket_failed')); }
  }
  #settle(): void { this.#state = !this.#data.app ? 'unconfigured' : !this.#ready ? 'disconnected' : 'connected'; }
  #incomingKey(messageId: string): string { return createHash('sha256').update(JSON.stringify([this.#data.connectionId, this.#data.app?.domain, this.#data.app?.appId, messageId])).digest('hex'); }
  async #receive(message: FeishuIncomingText): Promise<void> {
    if (!this.#data.app || message.senderType !== 'user') return; // Unconfigured/robot messages are deliberately outside this channel.
    if (!['p2p', 'group'].includes(message.chatType) || !validId(message.messageId) || !validId(message.chatId) || !validId(message.senderOpenId) || !validId(message.tenantKey) || !Number.isFinite(Date.parse(message.createdAt))) throw new FeishuFailureError(failure('receive', 'invalid_message'));
    if (message.messageType === 'text') this.#failures.delete('receive');
    if (message.messageId === this.#data.pairingMessageId) return; // Previously consumed control input stays consumed.
    if (this.#data.recentMessages.includes(message.messageId)) return; // Preserve pre-upgrade durable dedup evidence.
    const key = this.#incomingKey(message.messageId); const digest = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const previous = await this.#store!.loadIncoming<unknown>(key);
    if (previous !== null) { if (incomingReceipt(previous).digest !== digest) throw new FeishuFailureError(failure('receive', 'message_conflict')); return; }
    await this.#store!.saveIncoming(key, { digest, reference: message, delivered: false } satisfies IncomingReceipt, true, this.#data.connectionId);
    this.#startDrain(); // ACK only durable reception. Name lookup and Host delivery run separately.
  }
  #startDrain(): void {
    this.#drainRequested = true;
    if (this.#drain || this.#closed || this.#receiveFailed) return;
    this.#drainRequested = false;
    const epoch = this.#epoch;
    // Schedule after the current short state-write queue has released.
    this.#drain = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#drainInbox(epoch)).catch(error => {
      if (this.#closed || epoch !== this.#epoch || this.#receiveAbort.signal.aborted) return;
      this.#remember('inbox_delivery', error, 'host_delivery_failed');
      this.#receiveFailed = true; this.#state = 'error'; this.#error = '消息已保存在私有收件箱，姓名解析或 Host 投递失败。修复存储后重连；不会重新执行已接收的消息。';
    }).finally(() => { this.#drain = undefined; if (this.#drainRequested && !this.#receiveAbort.signal.aborted) this.#startDrain(); });
  }
  async #drainInbox(epoch: number): Promise<void> {
    const signal = AbortSignal.any([this.#abort.signal, this.#receiveAbort.signal]);
    while (!signal.aborted && epoch === this.#epoch) {
      const pending = await this.#queue(() => this.#store!.nextIncoming<unknown>(this.#data.connectionId));
      if (!pending) return;
      let receipt = incomingReceipt(pending.receipt);
      if (receipt.delivered) throw new Error('Invalid pending inbox state');
      if (!receipt.wake) {
        let user: FeishuUser | null = null; let senderNameFailure: FeishuFailure | undefined;
        try { user = await this.#sdk.getUser(this.#credentials!, receipt.reference.senderOpenId, 'open_id', AbortSignal.any([signal, AbortSignal.timeout(1500)])); }
        catch (error) { signal.throwIfAborted(); senderNameFailure = this.#remember('sender_lookup', error); }
        signal.throwIfAborted();
        if (user) this.#failures.delete('sender_lookup');
        else senderNameFailure ??= this.#remember('sender_lookup', undefined, 'name_unavailable');
        const source = receipt.reference;
        const wake: ExtensionWake = { id: pending.callId, reason: source.chatType === 'group' ? 'Group Feishu message' : 'Private Feishu message', event: { id: pending.callId, type: 'feishu.message', occurredAt: source.createdAt,
          message: { direction: 'inbound', text: preview(source.text), sourceLabel: (this.#data.app!.domain === 'feishu' ? '飞书' : 'Lark') + (source.chatType === 'group' ? '群聊' : ''), senderId: source.senderOpenId, senderVerified: true },
          payload: { senderName: user?.name ?? '姓名暂不可用', senderOpenId: source.senderOpenId, messageId: source.messageId, ...preservedText(source.text),
            ...(senderNameFailure ? { senderNameFailure } : {}),
            ...(source.messageType !== 'text' ? { messageFailure: failure('receive', 'unsupported_message') } : {}),
            ...(source.chatType === 'group' ? { chatType: 'group', chatId: source.chatId } : {}),
            ...(source.replyToMessageId ? { replyToMessageId: source.replyToMessageId } : {}) } } };
        receipt = { ...receipt, wake };
        await this.#queue(async () => { signal.throwIfAborted(); if (epoch !== this.#epoch) throw new Error('Retired inbox');
          this.#directoryIssue = user ? null : 'name_unavailable'; await this.#store!.saveIncoming(pending.callId, receipt, true, this.#data.connectionId); });
      }
      signal.throwIfAborted(); if (epoch !== this.#epoch) return;
      const frozenFailure = object(receipt.wake!.event.payload) ? readFailure(receipt.wake!.event.payload.senderNameFailure) : undefined;
      if (frozenFailure) this.#remember('sender_lookup', new FeishuFailureError(frozenFailure));
      try { await this.#context.requestWake(receipt.wake!); } catch (error) { throw new FeishuFailureError(diagnose('inbox_delivery', error, 'host_delivery_failed')); }
      this.#failures.delete('inbox_delivery');
      await this.#queue(async () => { signal.throwIfAborted(); if (epoch !== this.#epoch) throw new Error('Retired inbox');
        // Published body is now in Host history. Keep identity/digest and routing for duplicates and replies.
        await this.#store!.saveIncoming(pending.callId, { digest: receipt.digest, reference: { ...receipt.reference, text: '' }, delivered: true } satisfies IncomingReceipt, false, this.#data.connectionId); });
    }
  }
  async #stopDrain(): Promise<void> { this.#receiveAbort.abort(); await this.#drain; }
  async #flush(): Promise<void> {
    while (this.#data.inbox.length) {
      const wake = projectedWake(this.#data.inbox[0]!);
      if (wake !== this.#data.inbox[0]) { const next = structuredClone(this.#data); next.inbox[0] = wake; await this.#save(next); }
      try { await this.#context.requestWake(wake); const next = structuredClone(this.#data); next.inbox.shift(); await this.#save(next); }
      catch (error) { this.#remember('inbox_delivery', error, 'host_delivery_failed'); this.#state = 'error'; this.#error = '收到的消息仍保存在本地待投递。请修复持久存储后重连；不会重复启动同一个消息的 Wake。'; throw new Error('Feishu durable reception failed'); }
    }
  }
  async #changeConnection(signal: AbortSignal, change: () => Promise<void>): Promise<void> {
    signal.throwIfAborted();
    await this.#retireSend();
    await this.#stopDrain();
    await this.#queue(async () => {
      if (signal.aborted) {
        // The previous generation has drained. New calls can use the unchanged
        // binding, but queued old calls retain their aborted signal and never replay.
        this.#sendAbort = new AbortController(); this.#receiveAbort = new AbortController(); this.#startDrain(); signal.throwIfAborted();
      }
      await change();
    });
  }
  async #retireSend(): Promise<void> { this.#sendAbort.abort(); await this.#sending.catch(() => {}); } // Drain only; the tool caller owns the original failure.
  #send(callId: string, args: SendArgs, signal: AbortSignal): Promise<SendResult> {
    const combined = AbortSignal.any([signal, this.#abort.signal, this.#sendAbort.signal]);
    // A failed prior call must not poison later calls; its own promise/result retains the failure.
    const operation = this.#sending.catch(() => {}).then(() => this.#sendParts(callId, args, combined));
    this.#sending = operation; return operation;
  }
  async #resolveTarget(args: SendArgs, credentials: FeishuCredentials, signal: AbortSignal): Promise<{ target: Target } | { result: SendResult }> {
    let target: Target | undefined;
    if (args.recipientName) {
      const result = await this.#sdk.searchUsers(credentials, args.recipientName, signal);
      this.#directoryIssue = result.complete ? null : result.reason ?? 'directory_failed';
      if (!result.complete) { const diagnostic = this.#remember('directory_search', result.diagnostic ? new FeishuFailureError(result.diagnostic) : undefined, 'directory_failed'); return { result: { status: 'not_sent', reason: 'incomplete_search', diagnostic, candidates: result.users.slice(0, 20) } }; }
      this.#failures.delete('directory_search');
      const exact = result.users.filter(user => normalizedName(user.name) === normalizedName(args.recipientName!));
      if (exact.length !== 1) return { result: { status: 'not_sent', reason: result.users.length ? 'ambiguous_recipient' : 'recipient_not_found', candidates: result.users.slice(0, 20) } };
      target = { recipientId: exact[0]!.openId, recipientIdType: 'open_id', name: exact[0]!.name };
    } else if (args.recipientId) target = { recipientId: args.recipientId, recipientIdType: args.recipientIdType ?? 'open_id' };
    else if (args.chatId) target = { chatId: args.chatId };
    if (args.replyToMessageId) {
      const reference = await this.#queue(async () => {
        const saved = await this.#store!.loadIncoming<unknown>(this.#incomingKey(args.replyToMessageId!));
        if (saved !== null) return incomingReceipt(saved).reference;
        // Existing verified references survive this upgrade without changing their History.
        return this.#data.owner && this.#data.recentMessages.includes(args.replyToMessageId!) ? { senderOpenId: this.#data.owner.senderOpenId, chatId: this.#data.owner.chatId } : null;
      });
      if (!reference) return { result: { status: 'not_sent', reason: 'unknown_reply_target' } };
      const group = 'chatType' in reference && reference.chatType === 'group';
      if (target?.chatId && target.chatId !== reference.chatId) return { result: { status: 'not_sent', reason: 'reply_chat_mismatch' } };
      if (target?.recipientId) {
        if (group) return { result: { status: 'not_sent', reason: 'reply_recipient_mismatch' } };
        let openId: string | undefined = target.recipientId;
        if (target.recipientIdType === 'user_id') {
          try { openId = (await this.#sdk.getUser(credentials, target.recipientId!, 'user_id', signal))?.openId; }
          catch (error) { signal.throwIfAborted(); return { result: { status: 'not_sent', reason: 'recipient_lookup_failed', diagnostic: this.#remember('recipient_lookup', error) } }; }
          if (!openId) return { result: { status: 'not_sent', reason: 'recipient_lookup_failed', diagnostic: this.#remember('recipient_lookup', undefined, 'name_unavailable') } };
          this.#failures.delete('recipient_lookup');
        }
        if (!openId || openId !== reference.senderOpenId) return { result: { status: 'not_sent', reason: 'reply_recipient_mismatch' } };
      }
      target = { ...(!group ? { recipientId: reference.senderOpenId, recipientIdType: 'open_id' as const } : {}), chatId: reference.chatId, ...(target?.name ? { name: target.name } : {}) };
    }
    return target ? { target } : { result: { status: 'not_sent', reason: 'Specify recipientName, recipientId, chatId or replyToMessageId.' } };
  }
  async #sendParts(callId: string, args: SendArgs, signal: AbortSignal): Promise<SendResult> {
    const { text, replyToMessageId } = args;
    let publicationFailure: FeishuFailure | undefined;
    const summary = (receipt: Receipt): SendResult => ({ status: receipt.parts.every(part => part.status === 'sent') ? 'sent' : receipt.parts.some(part => part.status === 'unknown') ? 'unknown' : receipt.parts.some(part => part.status === 'sent') ? 'partial' : 'not_sent',
      ...(receipt.parts.some(part => part.failure) ? { diagnostics: receipt.parts.flatMap(part => { const diagnostic = readFailure(part.failure); return diagnostic ? [diagnostic] : []; }) } : {}),
      ...(publicationFailure ? { publicationFailure } : {}),
      ...(receipt.target ? { recipient: receipt.target } : {}), messageIds: receipt.parts.flatMap(part => part.messageId ? [part.messageId] : []), sentParts: receipt.parts.filter(part => part.status === 'sent').length, totalParts: receipt.parts.length });
    const chunks: string[] = []; let chunk = ''; let length = 0;
    if (!text.trim() || Buffer.byteLength(text) > 100_000 || !validId(callId)) return { status: 'not_sent', reason: 'Text must contain 1–100000 UTF-8 bytes with a valid call identity.' };
    for (const character of text) { const size = Buffer.byteLength(character); if (length + size > 6000) { chunks.push(chunk); chunk = ''; length = 0; } chunk += character; length += size; }
    if (chunk) chunks.push(chunk);
    const connectionId = this.#data.connectionId;
    const identity = [connectionId, text, replyToMessageId ?? null, args.recipientName ?? null, args.recipientId ?? null, args.recipientIdType ?? 'open_id'];
    if (args.chatId !== undefined) identity.push(args.chatId); // Preserve every existing private-send identity.
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const oldDigest = !args.recipientName && !args.recipientId && !args.chatId ? createHash('sha256').update(JSON.stringify([connectionId, text, replyToMessageId ?? null])).digest('hex') : null;
    let receipt!: Receipt;
    const prior = await this.#queue(async () => {
      if (!this.#storageReady || !this.#store) return { result: { status: 'not_sent' as const, reason: 'Private Feishu state is unavailable; reconcile before sending.' } };
      const previous = await this.#store.loadReceipt<unknown>(callId); const existing = previous === null ? null : storedReceipt(previous);
      if (existing) {
        const same = existing.digest === digest || existing.digest === oldDigest;
        if (same) { try { await this.#flushPublications(); } catch (error) { publicationFailure = this.#remember('outbound_publication', error, 'publication_failed'); } }
        return { result: same ? summary(existing) : { status: 'not_sent' as const, reason: 'Call identity conflicts with previously recorded content or recipient.' } };
      }
      if (!this.#ready || !this.#credentials) return { result: { status: 'not_sent' as const, reason: 'Connect the Feishu app first.' } };
      signal.throwIfAborted(); return { credentials: this.#credentials };
    });
    if ('result' in prior) return prior.result;
    let resolved;
    try { resolved = await this.#resolveTarget(args, prior.credentials, signal); }
    catch (error) { signal.throwIfAborted(); return { status: 'not_sent', reason: 'target_resolution_failed', diagnostic: this.#remember('recipient_lookup', error) }; }
    if ('result' in resolved) return resolved.result;
    const target = resolved.target;
    await this.#queue(async () => {
      signal.throwIfAborted(); if (this.#data.connectionId !== connectionId) throw new Error('Retired Feishu binding');
      receipt = await this.#saveReceipt(callId, { digest, connectionId, target, parts: chunks.map(() => ({ uuid: randomUUID(), status: 'not_started' })) });
    });
    const flush = () => this.#queue(() => this.#flushPublications()).catch(error => { publicationFailure = this.#remember('outbound_publication', error, 'publication_failed'); });
    for (let index = 0; index < chunks.length; index++) {
      if (signal.aborted) { await flush(); return summary(receipt); }
      const uuid = await this.#queue(async () => {
        signal.throwIfAborted();
        if (this.#data.connectionId !== connectionId) throw new Error('Retired Feishu binding');
        const intent = structuredClone(receipt); intent.parts[index]!.status = 'unknown'; receipt = await this.#saveReceipt(callId, intent); return receipt.parts[index]!.uuid;
      });
      try {
        signal.throwIfAborted();
        const sent = await this.#sdk.send(prior.credentials, { ...target, text: chunks[index]!, uuid, ...(replyToMessageId ? { replyToMessageId } : {}) });
        await this.#queue(async () => {
          if (this.#data.connectionId !== connectionId) throw new Error('Retired Feishu binding');
          const outcome = structuredClone(receipt);
          const publication: ExtensionEvent = { id: `sent:${connectionId}:${uuid}`, type: 'feishu.sent_message', occurredAt: new Date().toISOString(),
            payload: { messageId: sent.messageId, ...(sent.chatId ?? target.chatId ? { chatId: sent.chatId ?? target.chatId! } : {}), ...target, part: index + 1, totalParts: chunks.length },
            message: { direction: 'outbound', text: chunks[index]!, sourceLabel: this.#data.app!.domain === 'feishu' ? '飞书' : 'Lark' } };
          outcome.parts[index] = { ...outcome.parts[index]!, status: 'sent', messageId: sent.messageId, publication }; receipt = await this.#saveReceipt(callId, outcome);
        });
      } catch (error) {
        const diagnostic = this.#remember('send', error);
        if (!this.#closed) await this.#queue(async () => { const outcome = structuredClone(receipt); if (error instanceof FeishuSdkError && error.code === 'send_rejected') outcome.parts[index]!.status = 'rejected'; outcome.parts[index]!.failure = diagnostic; receipt = await this.#saveReceipt(callId, outcome); });
        await flush(); return { ...summary(receipt), reason: error instanceof FeishuSdkError && error.code === 'send_rejected' ? 'Feishu rejected this send; check app permissions and recipient availability.' : 'Delivery may have occurred. Check Feishu before another send; this call is never automatically replayed.' };
      }
    }
    this.#failures.delete('send'); await flush(); return summary(receipt);
  }
  async #flushPublications(): Promise<void> {
    let after = '';
    while (true) {
      const pending = await this.#store!.nextPendingReceipt<unknown>(this.#data.connectionId, after); if (!pending) { if (this.#failures.has('outbound_publication')) this.#error = null; this.#failures.delete('outbound_publication'); return; }
      const { callId } = pending; let receipt = storedReceipt(pending.receipt);
      if (receipt.connectionId !== this.#data.connectionId) throw new Error('Private Feishu receipt binding is invalid');
      for (let index = 0; index < receipt.parts.length; index++) {
        const part = receipt.parts[index]!;
        if (part.status !== 'sent' || !part.publication || part.published) continue;
        try {
          await this.#context.emitEvent(part.publication);
          const next = structuredClone(receipt); next.parts[index]!.published = true; receipt = await this.#saveReceipt(callId, next);
        } catch (error) { this.#error = '已确认的飞书发送仍待同步到网页，请修复持久存储后重连。不会重复发送。'; throw new FeishuFailureError(this.#remember('outbound_publication', error, 'publication_failed')); }
      }
      after = callId;
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#abort.abort(); this.#epoch++; this.#authorization = null;
    await this.#retireSend(); await this.#stopDrain(); await this.#serial.catch(() => {}); await this.#disconnect(); this.#state = 'disconnected';
  }
}
