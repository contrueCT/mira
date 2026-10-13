# @mira/cognition

`CognitionRuntime.continueTurn` 延续同一 Mira；`CognitionTurn` 携带持久批次标识及输入，适配器从权威存储核对输入/最终回复关联。接口不包含 Pi、数据库或文件系统类型。

普通文本溢出文件仅通过一个写入函数提供路径，不构建专用读取服务。契约见 `src/index.ts`，行为见 [ADR 0002](../../docs/adr/0002-coalesced-wake-loop.md)。

`CognitionTurn.attachments` carries ordered validated `AttachmentReference` values
(name, opaque ID, detected MIME, bytes, SHA-256, immutable local path). These are
provider-neutral references; runtime hydration never changes the original turn.
