/** Fixed model/settings projection. Never copy upstream messages, URLs or causes. */
export type FeishuOperation = 'registration' | 'connection' | 'receive' | 'sender_lookup' | 'directory_search' | 'recipient_lookup' | 'send' | 'inbox_delivery' | 'outbound_publication' | 'storage';
const explanations = {
  unknown: '原因尚不明确；请检查飞书应用配置和服务器状态。',
  missing_permissions: '接口权限不足；请检查应用已生效的权限、发布审批及可用范围。',
  token_rejected: '应用令牌被拒绝；请核对应用凭证、服务区域和应用状态。',
  timeout: '请求超时；本次未取得完整结果。',
  network: '网络请求失败；请检查服务器网络、DNS、代理及 TLS 证书。',
  rate_limited: '飞书接口限流；本次操作未自动重试。',
  api_rejected: '飞书接口返回非成功错误码；请根据错误码检查该操作。',
  invalid_response: '接口响应缺少必要字段或身份不一致，无法确认有效结果。',
  name_unavailable: '未取得有效姓名；请检查用户信息和姓名字段权限、通讯录范围。',
  incomplete_directory: '通讯录内容或分页不完整，无法确认唯一收件人。',
  directory_changed: '查询期间同一用户的姓名发生冲突，未确认唯一收件人。',
  unexpanded_user_groups: '通讯录含尚未展开的用户组，无法确认唯一收件人。',
  budget_exceeded: '通讯录查询达到时间、请求数或人数上限，结果不完整。',
  directory_failed: '通讯录查询失败，未取得完整结果。',
  storage_unavailable: '私有存储不可用；请检查文件权限、磁盘和数据库，不要清空原记录。',
  storage_busy: '私有数据库忙；请核对运行实例和存储状态。',
  storage_conflict: '私有存储版本冲突；请核对其他写入者，未覆盖原记录。',
  host_delivery_failed: '消息已保存，但提交给 Mira Host 失败；修复后重连，不要重复发送原消息。',
  publication_failed: '飞书发送已确认，但同步到网页失败；修复后重连，不要重新发送。',
  message_conflict: '同一消息 ID 的内容发生冲突，未发布冲突输入；请核对来源消息。',
  invalid_frame: '飞书 WebSocket 入站帧解码或处理失败，可能缺失消息；请核对群消息记录。',
  invalid_fragments: '飞书事件分片合并失败，消息未完整交付；请核对缺失消息。',
  invalid_pong: '飞书 WebSocket 心跳响应无效，请检查长连接状态。',
  websocket_send_failed: 'WebSocket 帧发送失败，可能影响心跳或消息确认；请核对连接和消息送达情况。',
  access_denied: '接口访问被拒绝；请检查应用权限、可用范围或服务器代理。',
  service_unavailable: '飞书服务或中间代理返回服务器错误，本次未取得确定结果。',
  invalid_message: '收到的消息字段或正文格式无效，无法安全接收；连接已停止，请核对缺失消息。',
  unsupported_message: '该消息类型暂不支持，原媒体未下载；请让发送者提供文字。',
  credentials_missing: '尚未保存有效应用凭证，请在扩展设置配置。',
  bot_unavailable: '无法验证机器人身份，请检查机器人能力和应用发布状态。',
  scope_query_failed: '无法读取应用权限列表，请检查应用状态与租户审批。',
  connection_timeout: 'WebSocket 长连接未在时限内就绪，请检查网络和事件订阅。',
  websocket_failed: 'WebSocket 长连接失败，请检查网络和长连接事件订阅。',
  registration_expired: '扫码授权已过期，请核对是否已创建应用后重新申请。',
  registration_denied: '扫码授权被拒绝，请检查租户审批。',
  registration_unknown: '应用注册结果未知；请先核对后台，避免重复创建应用。',
  cancelled: '操作已在本地取消；不代表远端已撤销，请核对实际结果。',
} as const;
export type FeishuFailureReason = keyof typeof explanations;
export type FeishuFailure = { operation: FeishuOperation; reason: FeishuFailureReason; message: string; apiCode?: number; httpStatus?: number };
export function failure(operation: FeishuOperation, reason: FeishuFailureReason, metadata: { apiCode?: unknown; httpStatus?: unknown } = {}): FeishuFailure {
  return { operation, reason, message: explanations[reason],
    ...(typeof metadata.apiCode === 'number' && Number.isSafeInteger(metadata.apiCode) && metadata.apiCode > 0 && metadata.apiCode <= 999_999_999 ? { apiCode: metadata.apiCode } : {}),
    ...(typeof metadata.httpStatus === 'number' && Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 100 && metadata.httpStatus <= 599 ? { httpStatus: metadata.httpStatus } : {}) };
}
export class FeishuFailureError extends Error {
  readonly diagnostic: FeishuFailure;
  constructor(diagnostic: FeishuFailure) {
    const safe = readFailure(diagnostic) ?? failure('connection', 'unknown');
    super(safe.message); this.name = 'FeishuFailureError'; this.diagnostic = Object.freeze(safe);
  }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readFailure(value: unknown): FeishuFailure | undefined {
  const item = record(value);
  if (!['registration', 'connection', 'receive', 'sender_lookup', 'directory_search', 'recipient_lookup', 'send', 'inbox_delivery', 'outbound_publication', 'storage'].includes(String(item.operation))
    || typeof item.reason !== 'string' || !Object.hasOwn(explanations, item.reason)) return undefined;
  return failure(item.operation as FeishuOperation, item.reason as FeishuFailureReason, item);
}
export function diagnose(operation: FeishuOperation, error: unknown, fallback: FeishuFailureReason = 'unknown'): FeishuFailure {
  if (error instanceof FeishuFailureError) return failure(operation, error.diagnostic.reason, error.diagnostic);
  const source = record(error); const response = record(source.response); const data = record(response.data);
  const code = data.code ?? source.code; const status = typeof response.status === 'number' && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
  const reason: FeishuFailureReason = status === 429 ? 'rate_limited'
    : ['ETIMEDOUT', 'ECONNABORTED'].includes(String(source.code)) || source.name === 'TimeoutError' ? 'timeout'
    : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ERR_NETWORK', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(String(source.code)) ? 'network'
    : typeof status === 'number' && status >= 500 ? 'service_unavailable'
    : [99991672, 99991679].includes(Number(code)) ? 'missing_permissions'
    : status === 403 ? 'access_denied'
    : status === 401 || [99991661, 99991663, 99991664, 99991668].includes(Number(code)) ? 'token_rejected'
    : source.name === 'AbortError' ? 'cancelled'
    : typeof code === 'number' && code !== 0 ? 'api_rejected' : fallback;
  return failure(operation, reason, { apiCode: code, httpStatus: status });
}
