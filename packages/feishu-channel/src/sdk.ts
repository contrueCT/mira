import { registerApp } from '@larksuite/channel';
import { Client, DefaultCache, Domain, EventDispatcher, LoggerLevel, WSClient, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import type { HttpInstance, Logger } from '@larksuiteoapi/node-sdk';

export type FeishuDomain = 'feishu' | 'lark';
export interface FeishuCredentials { appId: string; appSecret: string; domain: FeishuDomain; ownerOpenId?: string }
export type FeishuConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed' | 'receive_failed' | 'unsupported_message';
export interface FeishuIncomingText {
  messageId: string; chatId: string; chatType: 'p2p' | 'group'; senderOpenId: string;
  senderType: string; tenantKey: string; createdAt: string; text: string; messageType: string;
  replyToMessageId?: string; rootMessageId?: string;
}
export interface FeishuRegistrationOptions {
  domain: FeishuDomain; signal: AbortSignal;
  onQRCode(info: { url: string; expireIn: number }): void;
  onStatus(status: 'polling' | 'slow_down' | 'domain_switched'): void;
}
export interface FeishuConnection { close(): Promise<void>; state(): FeishuConnectionState }
export interface FeishuSdk {
  register(options: FeishuRegistrationOptions): Promise<FeishuCredentials>;
  verify(credentials: FeishuCredentials): Promise<{ botOpenId: string; scopes: string[] }>;
  connect(credentials: FeishuCredentials, handlers: {
    onMessage(message: FeishuIncomingText): Promise<void>;
    onState(state: FeishuConnectionState): void;
  }): Promise<FeishuConnection>;
  send(credentials: FeishuCredentials, message: { chatId: string; text: string; uuid: string; replyToMessageId?: string }): Promise<{ messageId: string }>;
}
export const FEISHU_REQUIRED_SCOPES = ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] as const;
export class FeishuSdkError extends Error {
  readonly code: 'registration_failed' | 'registration_expired' | 'registration_denied' | 'verification_failed' | 'connection_failed' | 'receive_failed' | 'send_unknown';
  constructor(code: FeishuSdkError['code']) { super(`Feishu ${code}`); this.name = 'FeishuSdkError'; this.code = code; }
}
const quietLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const identity = (value: unknown): string => { const result = string(value); if (!result || result.length > 512 || /[\u0000-\u001f]/u.test(result)) throw new FeishuSdkError('receive_failed'); return result; };

/** Only parse raw platform IDs. No roster lookup, stale cutoff, batching or dedup. */
export function parseFeishuMessage(payload: unknown): FeishuIncomingText {
  const raw = record(payload); const message = record(raw.message); const sender = record(raw.sender);
  const messageType = identity(message.message_type);
  const chatType = message.chat_type;
  if (chatType !== 'p2p' && chatType !== 'group') throw new FeishuSdkError('receive_failed');
  if (typeof message.create_time !== 'string' || !/^\d+$/u.test(message.create_time)) throw new FeishuSdkError('receive_failed');
  const milliseconds = Number(message.create_time);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) throw new FeishuSdkError('receive_failed');
  let text = '[Unsupported Feishu message; please send text]';
  if (messageType === 'text') {
    try { const content = record(JSON.parse(string(message.content))); if (typeof content.text !== 'string') throw new Error(); text = content.text; }
    catch { throw new FeishuSdkError('receive_failed'); }
  }
  return {
    messageId: identity(message.message_id), chatId: identity(message.chat_id), chatType,
    senderOpenId: identity(record(sender.sender_id).open_id), senderType: identity(sender.sender_type),
    tenantKey: identity(sender.tenant_key ?? raw.tenant_key), createdAt: new Date(milliseconds).toISOString(), text, messageType,
    ...(message.parent_id ? { replyToMessageId: identity(message.parent_id) } : {}),
    ...(message.root_id ? { rootMessageId: identity(message.root_id) } : {}),
  };
}
export type FeishuHttpInstance = HttpInstance;
export type FeishuWsOptions = ConstructorParameters<typeof WSClient>[0];
export type FeishuWsTransport = Pick<WSClient, 'start' | 'close' | 'getConnectionStatus'>;
export interface FeishuSdkDependencies {
  httpInstance?: HttpInstance;
  registerApp?: typeof registerApp;
  createWebSocket?: (options: FeishuWsOptions) => FeishuWsTransport;
  connectTimeoutMs?: number;
}

export function createFeishuSdk(dependencies: FeishuSdkDependencies = {}): FeishuSdk {
  // A per-adapter wrapper bounds every REST request without mutating the SDK's global Axios defaults.
  // The official instance installs a response-data interceptor, despite its Axios return type.
  const underlying: HttpInstance = dependencies.httpInstance ?? defaultHttpInstance as unknown as HttpInstance;
  const http: HttpInstance = {
    request: options => underlying.request({ ...options, timeout: 15_000 }),
    get: (url, options) => underlying.get(url, { ...options, timeout: 15_000 }),
    post: (url, data, options) => underlying.post(url, data, { ...options, timeout: 15_000 }),
    put: (url, data, options) => underlying.put(url, data, { ...options, timeout: 15_000 }),
    patch: (url, data, options) => underlying.patch(url, data, { ...options, timeout: 15_000 }),
    delete: (url, options) => underlying.delete(url, { ...options, timeout: 15_000 }),
    head: (url, options) => underlying.head(url, { ...options, timeout: 15_000 }),
    options: (url, options) => underlying.options(url, { ...options, timeout: 15_000 }),
  };
  const client = (credentials: FeishuCredentials) => new Client({
    appId: credentials.appId, appSecret: credentials.appSecret,
    domain: credentials.domain === 'feishu' ? Domain.Feishu : Domain.Lark,
    httpInstance: http, cache: new DefaultCache(), logger: quietLogger, loggerLevel: LoggerLevel.fatal, source: 'mira',
  });
  const verify: FeishuSdk['verify'] = async credentials => {
    try {
      const api = client(credentials);
      const response: unknown = await api.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
      const bot = record(response);
      if (bot.code !== 0 || !string(record(bot.bot).open_id)) throw new Error();
      const scopeResponse = await api.application.v6.scope.list();
      if (scopeResponse.code !== 0 || !Array.isArray(scopeResponse.data?.scopes)) throw new Error();
      const scopes = scopeResponse.data.scopes.filter(scope => scope.grant_status === 1 && scope.scope_type === 'tenant').map(scope => scope.scope_name);
      if (!FEISHU_REQUIRED_SCOPES.every(scope => scopes.includes(scope))) throw new Error();
      return { botOpenId: string(record(bot.bot).open_id), scopes };
    } catch { throw new FeishuSdkError('verification_failed'); }
  };
  return {
    async register(options) {
      try {
        options.signal.throwIfAborted();
        const result = await (dependencies.registerApp ?? registerApp)({
          domain: options.domain === 'feishu' ? 'accounts.feishu.cn' : 'accounts.larksuite.com',
          larkDomain: 'accounts.larksuite.com', signal: options.signal, source: 'mira', createOnly: true,
          appPreset: { name: 'Mira', desc: 'Mira personal assistant text channel' },
          addons: { preset: false, scopes: { tenant: [...FEISHU_REQUIRED_SCOPES], user: [] }, events: { items: { tenant: ['im.message.receive_v1'], user: [] } } },
          onQRCodeReady: info => { if (!options.signal.aborted) options.onQRCode(info); },
          onStatusChange: info => { if (!options.signal.aborted) options.onStatus(info.status); },
        });
        options.signal.throwIfAborted();
        if (!result.client_id || !result.client_secret || (result.user_info?.tenant_brand && result.user_info.tenant_brand !== options.domain)) throw new Error();
        return { appId: result.client_id, appSecret: result.client_secret, domain: result.user_info?.tenant_brand ?? options.domain,
          ...(result.user_info?.open_id ? { ownerOpenId: result.user_info.open_id } : {}) };
      } catch (error) {
        const code = record(error).code;
        throw new FeishuSdkError(code === 'expired_token' ? 'registration_expired' : code === 'access_denied' ? 'registration_denied' : 'registration_failed');
      }
    },
    verify,
    async connect(credentials, handlers) {
      let state: FeishuConnectionState = 'connecting';
      const setState = (next: FeishuConnectionState) => { state = next; handlers.onState(next); };
      setState('connecting');
      try { await verify(credentials); } catch { setState('failed'); throw new FeishuSdkError('connection_failed'); }
      let socket: FeishuWsTransport | undefined;
      let stopped = false;
      const dispatcher = new EventDispatcher({ logger: quietLogger, loggerLevel: LoggerLevel.fatal, cache: new DefaultCache() });
      dispatcher.register({ 'im.message.receive_v1': async payload => {
        try {
          if (stopped) throw new Error();
          const message = parseFeishuMessage(payload);
          await handlers.onMessage(message); // Await only durable ingestion, never the model run.
          if (!stopped && message.messageType !== 'text') setState('unsupported_message');
        } catch {
          if (stopped) throw new FeishuSdkError('receive_failed');
          stopped = true; setState('receive_failed');
          // Official WSClient maps this rejection to a 500 ACK. Stop intake as well;
          // platform redelivery is not guaranteed and must never be advertised as such.
          setImmediate(() => socket?.close({ force: true }));
          throw new FeishuSdkError('receive_failed');
        }
      } });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = () => { if (settled) return; settled = true; clearTimeout(timer); stopped = true; socket?.close({ force: true }); setState('failed'); reject(new FeishuSdkError('connection_failed')); };
        const budget = dependencies.connectTimeoutMs ?? 15_000;
        const timer = setTimeout(fail, Number.isFinite(budget) && budget > 0 ? Math.min(budget, 2_147_483_647) : 15_000);
        try {
          socket = (dependencies.createWebSocket ?? (options => new WSClient(options)))({
            appId: credentials.appId, appSecret: credentials.appSecret,
            domain: credentials.domain === 'feishu' ? Domain.Feishu : Domain.Lark,
            httpInstance: http, logger: quietLogger, loggerLevel: LoggerLevel.fatal,
            source: 'mira', autoReconnect: true, handshakeTimeoutMs: 10_000, wsConfig: { pingTimeout: 30 },
            // SDK retry callbacks run immediately before isConnecting is cleared.
            onReady: () => queueMicrotask(() => { if (settled || stopped) return; if (socket?.getConnectionStatus().state !== 'connected') { fail(); return; } settled = true; clearTimeout(timer); setState('connected'); resolve(); }),
            onError: () => { if (!settled) fail(); else if (!stopped) { stopped = true; socket?.close({ force: true }); setState('failed'); } },
            onReconnecting: () => { if (!stopped) setState('reconnecting'); },
            onReconnected: () => queueMicrotask(() => { if (!stopped && socket?.getConnectionStatus().state === 'connected') setState('connected'); }),
          });
          void socket.start({ eventDispatcher: dispatcher }).catch(fail);
        } catch { fail(); }
      });
      return {
        async close() { stopped = true; socket?.close({ force: true }); setState('closed'); },
        state() { if (stopped) return state; const actual = socket?.getConnectionStatus().state; return actual === 'connected' ? state : actual === 'reconnecting' ? 'reconnecting' : actual === 'connecting' ? 'connecting' : 'failed'; },
      };
    },
    async send(credentials, message) {
      try {
        const api = client(credentials);
        const data = { msg_type: 'text', content: JSON.stringify({ text: message.text }), uuid: message.uuid };
        // Channel.send/reply retries unknown errors and may fallback to a new send.
        // These generated node-sdk endpoints make exactly one effectful HTTP call.
        const response = message.replyToMessageId
          ? await api.im.v1.message.reply({ path: { message_id: message.replyToMessageId }, data })
          : await api.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: message.chatId } });
        if (response.code !== 0 || !response.data?.message_id) throw new Error();
        return { messageId: response.data.message_id };
      } catch { throw new FeishuSdkError('send_unknown'); }
    },
  };
}
