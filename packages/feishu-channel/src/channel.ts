import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext, ExtensionEvent, ExtensionWake, ExtensionConnectionStatus, Json } from '@mira/extension-sdk';
import { FeishuPrivateStore } from './store.ts';
import { FeishuSdkError } from './sdk.ts';
import type { FeishuSdk, FeishuCredentials, FeishuIncomingText } from './sdk.ts';

type Owner = { tenantKey: string; senderOpenId: string; chatId: string };
type Part = { uuid: string; status: 'not_started' | 'unknown' | 'sent'; messageId?: string; publication?: ExtensionEvent; published?: boolean };
type SendResult = { status: 'sent' | 'unknown' | 'partial' | 'not_sent'; messageIds?: string[]; sentParts?: number; totalParts?: number; reason?: string };
type Receipt = { digest: string; parts: Part[] };
interface Stored {
  version: 1; registrationUnknown?: boolean; connectionId: string; app: { appId: string; domain: 'feishu' | 'lark' } | null;
  owner: Owner | null; pairingMessageId?: string; inbox: ExtensionWake[]; recentMessages: string[]; sends: Record<string, Receipt>;
}
interface Pairing { code: string; expiresAt: string }
const initial = (): Stored => ({ version: 1, connectionId: randomUUID(), app: null, owner: null, inbox: [], recentMessages: [], sends: {} });
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const sameOwner = (a: Owner, b: Owner) => a.tenantKey === b.tenantKey && a.senderOpenId === b.senderOpenId && a.chatId === b.chatId;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function stored(value: unknown): Stored {
  if (value === null) return initial();
  if (!object(value) || value.version !== 1 || !validId(value.connectionId) || !('app' in value) || !('owner' in value)
    || (value.app !== null && (!object(value.app) || !validId(value.app.appId) || !['feishu', 'lark'].includes(String(value.app.domain))))
    || (value.owner !== null && (!object(value.owner) || !validId(value.owner.tenantKey) || !validId(value.owner.senderOpenId) || !validId(value.owner.chatId)))
    || (value.registrationUnknown !== undefined && typeof value.registrationUnknown !== 'boolean') || (value.pairingMessageId !== undefined && !validId(value.pairingMessageId)) || !Array.isArray(value.inbox) || !Array.isArray(value.recentMessages) || !value.recentMessages.every(validId) || !object(value.sends)) throw new Error('Private Feishu state is invalid; it was not replaced');
  for (const item of value.inbox) if (!object(item) || !validId(item.id) || !object(item.event) || !validId(item.event.id) || item.event.type !== 'feishu.owner_message' || typeof item.event.occurredAt !== 'string' || !Number.isFinite(Date.parse(item.event.occurredAt))) throw new Error('Private Feishu state is invalid');
  for (const receipt of Object.values(value.sends)) if (!object(receipt) || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.digest) || !Array.isArray(receipt.parts) || receipt.parts.some(part => !object(part) || !validId(part.uuid) || !['not_started', 'unknown', 'sent'].includes(String(part.status)))) throw new Error('Private Feishu state is invalid');
  return value as unknown as Stored;
}
/** Per-activation state. All protocol, pairing and delivery decisions live in this extension. */
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
  #authorization: { url: string; expiresAt: string } | null = null;
  #pairing: Pairing | null = null;
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
        { id: 'connect', label: '连接已有应用', execute: ({ signal }) => this.#data.app ? this.#changeConnection(signal, async () => { await this.#disconnect(); await this.#connect(signal); }) : this.#queue(() => this.#manual(signal)) },
        { id: 'pair', label: '生成本人配对码', execute: async () => this.#queue(async () => {
          if (!this.#ready || this.#data.owner) throw new Error('先连接未绑定的机器人');
          this.#pairing = { code: randomBytes(18).toString('base64url'), expiresAt: new Date(Date.now() + 600_000).toISOString() }; this.#state = 'pending';
        }) },
        { id: 'cancel_pair', group: 'secondary', label: '取消配对', execute: async () => this.#queue(async () => { this.#pairing = null; this.#settle(); }) },
        { id: 'reconnect', group: 'secondary', label: '重新连接', execute: ({ signal }) => this.#changeConnection(signal, async () => { await this.#disconnect(); await this.#connect(signal); }) },
        { id: 'unbind', group: 'secondary', label: '解绑并清除本地凭据', execute: ({ signal }) => this.#changeConnection(signal, async () => {
          await this.#disconnect(); await this.#context.credentials.delete('appSecret'); await this.#save(initial()); this.#storageReady = true; this.#authorizationRetry = false; this.#credentials = undefined; this.#pairing = null; this.#error = null; this.#state = 'unconfigured';
        }) },
      ], status: () => this.status(),
    });
    this.#context.registerTool({ name: 'feishu_connect', description: 'Start this plugin’s connection action after the user asks to connect Feishu/Lark. Returns immediately while official authorization remains in this extension’s protected settings. Reuses the same settings operation and cancellation; never returns credentials, pairing challenges or provider URLs. An unknown registration must be reconciled in settings, not retried. Optional cancelOperationId cancels exactly that operation locally, without revoking remote effects.',
      parameters: { type: 'object', properties: { cancelOperationId: { type: 'string' } }, additionalProperties: false },
      execute: async (args, { signal }) => {
        signal.throwIfAborted();
        if (!object(args) || (args.cancelOperationId !== undefined && !validId(args.cancelOperationId))) return { text: 'Invalid connection arguments' };
        if (typeof args.cancelOperationId === 'string') { await actions.cancel(args.cancelOperationId); return { text: '已请求取消本次本地连接操作。请在扩展设置核对结果；取消不撤销远端已创建的应用。' }; }
        const current = await actions.current(); signal.throwIfAborted();
        const guidance = '请打开设置 → 扩展 → 本扩展的连接设置，查看官方授权二维码或链接，授权后生成本人配对码，发送配对码即可完成绑定。';
        if (current?.state === 'pending') return { text: JSON.stringify({ operation: current, instruction: guidance }) };
        if (this.#data.registrationUnknown && !this.#data.app) return { text: '上次注册结果未知，未重新申请。请在扩展设置核对官方后台并恢复已有应用，避免重复创建。' };
        if (this.#ready) return { text: JSON.stringify({ state: this.#state, instruction: this.#data.owner ? '已有连接，无需重复授权。' : guidance }) };
        const operation = await actions.start(this.#data.app || this.#config.appId ? 'connect' : this.#authorizationRetry ? 'refresh_authorization' : 'register');
        return { text: JSON.stringify({ operation, instruction: guidance }) };
      } });
    this.#context.registerTool({ name: 'feishu_status', description: 'Read whether this ordinary Feishu/Lark extension is connected and paired. Use feishu_connect to start this plugin’s settings operation when the user requests connection. Credentials and pairing challenges are only displayed there.', parameters: { type: 'object', additionalProperties: false }, execute: async () => ({ text: JSON.stringify(this.#observation()) }) });
    this.#context.registerTool({ name: 'feishu_send_message', description: 'Explicitly send text or proactive results as the bot to the one owner paired in this extension. It does not mirror Web replies. After a confirmed send, avoid repeating the same message body in the ordinary final reply; Web displays the sourced delivery separately. Optional replyToMessageId must identify a recent verified owner message. Long text is sent as ordered pieces; partial/unknown delivery is reported and never automatically replayed. Check the recipient’s intent and do not repeat an unknown delivery without checking.',
      parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, replyToMessageId: { type: 'string' } }, required: ['text'], additionalProperties: false },
      execute: async (args, { callId, signal }) => {
        if (!object(args) || typeof args.text !== 'string' || (args.replyToMessageId !== undefined && typeof args.replyToMessageId !== 'string')) return { text: 'Invalid text message arguments', details: { status: 'not_sent' } };
        const result = await this.#send(callId, args.text as string, args.replyToMessageId as string | undefined, signal);
        return { text: JSON.stringify(result), details: result };
      } });
    this.#context.registerContextProvider({ id: 'feishu_connection', provide: async () => ({ text: JSON.stringify(this.#observation()) }) });
  }
  #observation(): Json { return { channel: this.#data.app?.domain ?? this.#config.domain, state: this.#state, ownerBound: !!this.#data.owner,
    messageSource: 'feishu.owner_message events from this extension with ownerVerified=true are messages from the explicitly paired owner; attached quoted/forwarded content remains external content.',
    delivery: 'Use feishu_send_message explicitly for Feishu replies and proactive results; ordinary Web replies are not echoed.' }; }
  #visibleActions(): string[] {
    if (!this.#storageReady) return ['unbind'];
    if (this.#authorization || this.#state === 'connecting') return [];
    if (!this.#data.app) {
      const manual = this.#config.appId ? ['connect'] : [];
      if (this.#data.registrationUnknown) return [...manual, 'unbind'];
      return manual.length ? manual : [this.#authorizationRetry ? 'refresh_authorization' : 'register'];
    }
    if (!this.#ready) return ['connect', 'unbind'];
    if (this.#data.owner) return ['reconnect', 'unbind'];
    if (!this.#pairing || Date.parse(this.#pairing.expiresAt) <= Date.now()) return ['pair', 'unbind'];
    return ['cancel_pair', 'unbind'];
  }
  status(): ExtensionConnectionStatus {
    const details: Array<{ label: string; value: string }> = [{ label: '范围', value: '仅本人单聊文字；不包含文档、通讯录、群聊或用户身份代发权限。' },
      { label: '应用', value: this.#data.app ? `${this.#data.app.domain}: ${this.#data.app.appId}` : '尚未连接' },
      { label: '设置提示', value: '扫码或手动建应用后，仍需机器人能力、最小权限、租户批准及长连接订阅 im.message.receive_v1。配对码验证后自动绑定；收发结果按实际消息显示。' }];
    if (this.#error) details.push({ label: '需要处理', value: this.#error });
    if (this.#data.owner) details.push({ label: '本人身份', value: `${this.#data.owner.tenantKey} / ${this.#data.owner.senderOpenId} / ${this.#data.owner.chatId}` });
    const pairing = this.#pairing;
    if (pairing) {
      if (Date.parse(pairing.expiresAt) <= Date.now()) details.push({ label: '配对', value: '配对码已过期，请重新生成。' });
      else {
        details.push({ label: '请在机器人单聊中发送', value: `/mira pair ${pairing.code}` }, { label: '过期时间', value: pairing.expiresAt });
      }
    }
    if (this.#data.registrationUnknown && !this.#data.app && this.#state !== 'connecting' && this.#state !== 'pending') details.push({ label: '注册结果待核对', value: '上次注册可能已创建应用。请先到官方后台核对，已有应用用手动配置恢复；确认未创建后才可解绑清除本地记录并重新申请。' });
    const authorization = this.#authorization && Date.parse(this.#authorization.expiresAt) > Date.now() ? this.#authorization : null;
    if (this.#authorization && !authorization) details.push({ label: '授权', value: '二维码已过期。等待本次操作结束后点击“重新申请授权”；仍在处理时可先取消。' });
    if (this.#authorization) details.push({ label: '授权链接有效期', value: this.#authorization.expiresAt });
    return { state: this.#state, visibleActions: this.#visibleActions(), ...(this.#error ? { code: 'unknown' as const } : {}), details,
      ...(authorization ? { authorization: { url: authorization.url, label: `在${this.#config.domain === 'feishu' ? '飞书' : 'Lark'}官方页面扫码确认应用与最小权限`, qr: true } } : {}) };
  }
  async initialize(): Promise<void> {
    if (!this.#store) { this.#state = 'error'; this.#error = '需要持久扩展安装身份和私有目录，尚未连接或读取凭据。'; return; }
    try { await this.#queue(async () => { this.#data = stored(await this.#store!.load()); this.#storageReady = true; if (this.#data.registrationUnknown && !this.#data.app) this.#state = 'error'; if (this.#data.app) await this.#connect(this.#abort.signal); }); }
    catch { this.#state = 'error'; this.#error = '私有状态或连接不可用，原状态未被清空。请检查本地存储及应用设置。'; }
  }
  #queue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#serial.catch(() => {}).then(async () => { if (this.#closed) throw new Error('Feishu extension is stopped'); return action(); }); this.#serial = operation; return operation;
  }
  async #save(data: Stored): Promise<void> { if (!this.#store || this.#closed) throw new Error('Feishu private storage unavailable'); await this.#store.save(data); this.#data = data; }
  async #readCredentials(): Promise<FeishuCredentials> {
    if (!this.#data.app) throw new Error('No Feishu app is configured');
    const appSecret = await this.#context.credentials.get('appSecret');
    if (!appSecret) throw new Error('Feishu app credentials are missing');
    return { ...this.#data.app, appSecret };
  }
  async #manual(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#storageReady) throw new Error('私有状态尚未安全读取，手动连接不能覆盖原记录；请先修复存储或明确解绑重置');
    if (this.#data.app) throw new Error('请先解绑现有应用，再切换应用或手动配置');
    const appSecret = await this.#context.credentials.get('appSecret');
    if (!validId(this.#config.appId) || !appSecret) throw new Error('请先保存 App ID、服务类型和 App Secret');
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
        await this.#context.credentials.set('appSecret', credentials.appSecret);
        await this.#save({ ...initial(), app: { appId: credentials.appId, domain: credentials.domain } });
        await this.#connect(combined);
      });
    } catch (error) {
      if (!this.#closed && error instanceof FeishuSdkError && (error.code === 'registration_expired' || error.code === 'registration_denied') && !combined.aborted) await this.#queue(async () => { await this.#save({ ...structuredClone(this.#data), registrationUnknown: false }); this.#authorizationRetry = true; });
      if (!this.#closed) { this.#state = this.#data.registrationUnknown && !this.#data.app ? 'error' : combined.aborted ? (this.#data.app ? 'disconnected' : 'unconfigured') : 'error'; this.#error = error instanceof FeishuSdkError && error.code === 'registration_expired' ? '授权已过期，旧二维码不可再用。点击“重新申请授权”获取新的授权请求；如已创建应用，请先用手动配置恢复。' : error instanceof FeishuSdkError && error.code === 'registration_denied' ? '授权被拒绝。本次操作已结束，可确认权限后重新申请。' : this.#data.registrationUnknown && !this.#data.app ? '注册结果未知或已取消。请先核对官方后台，避免重复创建应用；取消本地操作不撤销已创建的远端应用。' : combined.aborted ? null : '扫码注册、应用权限或连接验证未完成。请检查租户审批，也可使用手动配置。'; }
      throw new Error(combined.aborted ? 'Feishu registration cancelled' : 'Feishu registration was not verified');
    } finally { this.#authorization = null; }
  }
  async #connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (!this.#data.app) throw new Error('先连接应用');
    const credentials = await this.#readCredentials(); const epoch = ++this.#epoch; this.#state = 'connecting'; this.#error = null;
    try {
      const connection = await this.#sdk.connect(credentials, { onMessage: message => this.#queue(async () => {
        if (epoch !== this.#epoch || this.#closed) throw new Error('Retired Feishu connection');
        await this.#receive(message);
      }), onState: state => {
        if (epoch !== this.#epoch || this.#closed) return;
        if (state === 'unsupported_message') return;
        this.#ready = state === 'connected';
        if (this.#ready) this.#settle();
        else if (state === 'receive_failed') { this.#state = 'error'; this.#error = '消息接收持久化失败，连接已停止；请修复存储后重连并核对缺失消息。'; }
        else if (state === 'failed') { this.#state = 'error'; this.#error = '长连接失败，请检查网络、权限和事件订阅后重连。'; }
        else this.#state = state === 'closed' ? 'disconnected' : 'connecting';
      } });
      if (signal.aborted || this.#closed || epoch !== this.#epoch) { await connection.close(); signal.throwIfAborted(); throw new Error('Connection retired'); }
      this.#credentials = credentials; this.#connection = connection; this.#sendAbort = new AbortController(); this.#ready = connection.state() === 'connected';
      await this.#flush(); await this.#flushPublications(); this.#settle();
    } catch { this.#ready = false; this.#state = 'error'; this.#error = '机器人权限或长连接尚未验证，请检查凭据、最小权限、审批和长连接事件订阅。'; throw new Error('Feishu connection was not verified'); }
  }
  async #disconnect(): Promise<void> { this.#epoch++; this.#ready = false; const connection = this.#connection; this.#connection = undefined; this.#credentials = undefined; this.#settle(); await connection?.close(); }
  #settle(): void { this.#state = !this.#data.app ? 'unconfigured' : !this.#ready ? 'disconnected' : this.#data.owner ? 'connected' : 'pending'; }
  async #receive(message: FeishuIncomingText): Promise<void> {
    if (!this.#data.app || message.chatType !== 'p2p' || message.senderType !== 'user' || !validId(message.messageId) || !validId(message.chatId) || !validId(message.senderOpenId) || !validId(message.tenantKey) || !Number.isFinite(Date.parse(message.createdAt))) return;
    const owner = { tenantKey: message.tenantKey, senderOpenId: message.senderOpenId, chatId: message.chatId };
    if (!this.#data.owner) {
      const pairing = this.#pairing; if (!pairing || Date.parse(pairing.expiresAt) <= Date.now() || message.messageType !== 'text') return;
      const supplied = Buffer.from(message.text.trim()); const expected = Buffer.from(`/mira pair ${pairing.code}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
      await this.#save({ ...structuredClone(this.#data), owner, pairingMessageId: message.messageId });
      this.#pairing = null; this.#error = null; this.#settle(); return;
    }
    if (!sameOwner(this.#data.owner, owner)) return;
    // Pairing commands are control messages, never conversation or model input.
    if (message.messageId === this.#data.pairingMessageId || /^\/mira pair [A-Za-z0-9_-]+$/u.test(message.text.trim())) return;
    const id = createHash('sha256').update(JSON.stringify([this.#data.connectionId, this.#data.app.domain, this.#data.app.appId, message.messageId])).digest('hex');
    const wake: ExtensionWake = { id, reason: 'Message from the explicitly paired Mira owner', event: { id, type: 'feishu.owner_message', occurredAt: message.createdAt,
      message: { direction: 'inbound', text: message.text, sourceLabel: this.#data.app.domain === 'feishu' ? '飞书' : 'Lark', senderId: message.senderOpenId, senderVerified: true },
      payload: { channel: this.#data.app.domain, appId: this.#data.app.appId, ownerVerified: true, ...owner, messageId: message.messageId, messageType: message.messageType, text: message.text,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}), ...(message.rootMessageId ? { rootMessageId: message.rootMessageId } : {}) } } };
    const existing = this.#data.inbox.find(item => item.id === id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(wake)) throw new Error('Conflicting Feishu message identity');
    if (!existing) { const next = structuredClone(this.#data); next.inbox.push(wake); next.recentMessages = [...next.recentMessages.filter(item => item !== message.messageId), message.messageId].slice(-512); await this.#save(next); }
    await this.#flush();
  }
  async #flush(): Promise<void> {
    while (this.#data.inbox.length) {
      const wake = this.#data.inbox[0]!;
      try { await this.#context.requestWake(wake); const next = structuredClone(this.#data); next.inbox.shift(); await this.#save(next); }
      catch { this.#state = 'error'; this.#error = '收到的消息仍保存在本地待投递。请修复持久存储后重连；不会重复启动同一个消息的 Wake。'; throw new Error('Feishu durable reception failed'); }
    }
  }
  async #changeConnection(signal: AbortSignal, change: () => Promise<void>): Promise<void> {
    signal.throwIfAborted();
    await this.#retireSend();
    await this.#queue(async () => {
      if (signal.aborted) {
        // The previous generation has drained. New calls can use the unchanged
        // binding, but queued old calls retain their aborted signal and never replay.
        this.#sendAbort = new AbortController(); signal.throwIfAborted();
      }
      await change();
    });
  }
  async #retireSend(): Promise<void> { this.#sendAbort.abort(); await this.#sending.catch(() => {}); }
  #send(callId: string, text: string, replyToMessageId: string | undefined, signal: AbortSignal): Promise<SendResult> {
    const combined = AbortSignal.any([signal, this.#abort.signal, this.#sendAbort.signal]);
    const operation = this.#sending.catch(() => {}).then(() => this.#sendParts(callId, text, replyToMessageId, combined));
    this.#sending = operation; return operation;
  }
  async #sendParts(callId: string, text: string, replyToMessageId: string | undefined, signal: AbortSignal): Promise<SendResult> {
    const summary = (receipt: Receipt): SendResult => ({ status: receipt.parts.every(part => part.status === 'sent') ? 'sent' : receipt.parts.some(part => part.status === 'unknown') ? 'unknown' : receipt.parts.some(part => part.status === 'sent') ? 'partial' : 'not_sent',
      messageIds: receipt.parts.flatMap(part => part.messageId ? [part.messageId] : []), sentParts: receipt.parts.filter(part => part.status === 'sent').length, totalParts: receipt.parts.length });
    const chunks: string[] = []; let chunk = ''; let length = 0;
    if (!text.trim() || Buffer.byteLength(text) > 100_000 || !validId(callId)) return { status: 'not_sent', reason: 'Text must contain 1–100000 UTF-8 bytes with a valid call identity.' };
    for (const character of text) { const size = Buffer.byteLength(character); if (length + size > 6000) { chunks.push(chunk); chunk = ''; length = 0; } chunk += character; length += size; }
    if (chunk) chunks.push(chunk);
    const prepared = await this.#queue(async (): Promise<{ result: SendResult } | { credentials: FeishuCredentials; chatId: string; connectionId: string }> => {
      const digest = createHash('sha256').update(JSON.stringify([this.#data.connectionId, text, replyToMessageId ?? null])).digest('hex');
      const existing = this.#data.sends[callId];
      if (existing) { if (existing.digest === digest) await this.#flushPublications().catch(() => {}); return { result: existing.digest === digest ? summary(existing) : { status: 'not_sent', reason: 'Call identity conflicts with previously recorded content.' } }; }
      if (!this.#ready || !this.#credentials || !this.#data.owner) return { result: { status: 'not_sent', reason: 'Connect and explicitly pair the owner first.' } };
      if (replyToMessageId && !this.#data.recentMessages.includes(replyToMessageId)) return { result: { status: 'not_sent', reason: 'Quote target is not a recent verified owner message in this binding.' } };
      signal.throwIfAborted();
      const next = structuredClone(this.#data); next.sends[callId] = { digest, parts: chunks.map(() => ({ uuid: randomUUID(), status: 'not_started' })) }; await this.#save(next);
      return { credentials: this.#credentials, chatId: this.#data.owner.chatId, connectionId: this.#data.connectionId };
    });
    if ('result' in prepared) return prepared.result;
    const flush = () => this.#queue(() => this.#flushPublications()).catch(() => {});
    for (let index = 0; index < chunks.length; index++) {
      if (signal.aborted) { await flush(); return summary(this.#data.sends[callId]!); }
      const uuid = await this.#queue(async () => {
        signal.throwIfAborted();
        if (this.#data.connectionId !== prepared.connectionId) throw new Error('Retired Feishu binding');
        const intent = structuredClone(this.#data); intent.sends[callId]!.parts[index]!.status = 'unknown'; await this.#save(intent); return intent.sends[callId]!.parts[index]!.uuid;
      });
      try {
        signal.throwIfAborted();
        // No state lock across network I/O: inbound messages persist immediately.
        const sent = await this.#sdk.send(prepared.credentials, { chatId: prepared.chatId, text: chunks[index]!, uuid, ...(replyToMessageId ? { replyToMessageId } : {}) });
        await this.#queue(async () => {
          if (this.#data.connectionId !== prepared.connectionId) throw new Error('Retired Feishu binding');
          const outcome = structuredClone(this.#data);
          const publication: ExtensionEvent = { id: `sent:${outcome.connectionId}:${uuid}`, type: 'feishu.sent_message', occurredAt: new Date().toISOString(),
            payload: { channel: outcome.app!.domain, appId: outcome.app!.appId, callId, messageId: sent.messageId, chatId: prepared.chatId, part: index + 1, totalParts: chunks.length },
            message: { direction: 'outbound', text: chunks[index]!, sourceLabel: outcome.app!.domain === 'feishu' ? '飞书' : 'Lark' } };
          outcome.sends[callId]!.parts[index] = { ...outcome.sends[callId]!.parts[index]!, status: 'sent', messageId: sent.messageId, publication }; await this.#save(outcome);
        });
      } catch { await flush(); return { ...summary(this.#data.sends[callId]!), reason: 'Delivery may have occurred. Check Feishu before another send; this call is never automatically replayed.' }; }
    }
    await flush(); return summary(this.#data.sends[callId]!);
  }
  async #flushPublications(): Promise<void> {
    for (const [callId, receipt] of Object.entries(this.#data.sends)) {
      for (let index = 0; index < receipt.parts.length; index++) {
        const part = this.#data.sends[callId]!.parts[index]!;
        if (part.status !== 'sent' || !part.publication || part.published) continue;
        try {
          await this.#context.emitEvent(part.publication);
          const next = structuredClone(this.#data); next.sends[callId]!.parts[index]!.published = true; await this.#save(next);
        } catch { this.#error = '已确认的飞书发送仍待同步到网页，请修复持久存储后重连。不会重复发送。'; throw new Error('Feishu display persistence failed'); }
      }
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#abort.abort(); this.#epoch++; this.#authorization = null; this.#pairing = null;
    await this.#retireSend(); await this.#serial.catch(() => {}); await this.#disconnect(); this.#state = 'disconnected';
  }
}
