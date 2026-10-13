import { constants } from 'node:fs';
import { access, open, readFile } from 'node:fs/promises';
import { createReadTool, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { attachmentMime, type AttachmentStore } from './attachments.ts';

class VideoRead extends Error {
  readonly file: string; readonly mime: string;
  constructor(file: string, mime: string) { super('Explicit video read'); this.file = file; this.mime = mime; }
}

/** Keep Pi's schema/execution for ordinary files. Explicit video reads alone
 * create immutable snapshots; neither upload nor publication invokes this tool. */
export function withVideoRead(tool: AgentTool, store: AttachmentStore, cwd: string): AgentTool {
  if (tool.name !== 'read') return tool;
  // The public operations hook gets Pi's fully resolved path, preserving its
  // home/@/Unicode filename behavior without a second path resolver.
  const native = createReadTool(cwd, { operations: {
    access: file => access(file, constants.R_OK), readFile,
    detectImageMimeType: async file => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      let mime: string | undefined;
      try {
        if ((await handle.stat()).isFile()) {
          const prefix = Buffer.alloc(4096); const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          mime = attachmentMime(prefix.subarray(0, bytesRead));
        }
      } finally { await handle.close(); }
      if (mime === 'video/mp4' || mime === 'video/webm') throw new VideoRead(file, mime);
      return detectSupportedImageMimeTypeFromFile(file);
    },
  } });
  return { ...tool,
    description: `${tool.description} Local MP4/WebM videos are read only on explicit read calls: an immutable snapshot is supplied natively when the selected model supports video, otherwise a clear limitation is returned. No automatic frame/audio extraction. Video offset/limit are not supported.`,
    execute: async (id, raw, signal, onUpdate) => {
      signal?.throwIfAborted();
      const args = raw as { path: string; offset?: number; limit?: number };
      let video: VideoRead;
      try { return await native.execute(id, args, signal, onUpdate); }
      catch (error) { if (!(error instanceof VideoRead)) throw error; video = error; }
      signal?.throwIfAborted();
      if (args.offset !== undefined || args.limit !== undefined) throw Error('Video read does not support text line offset/limit; read the whole video file.');
      const snapshots = await store.snapshot([video.file], cwd);
      signal?.throwIfAborted();
      const attachments = await store.resolve(snapshots.map(item => item.id));
      if (attachments[0]?.mimeType !== video.mime) throw Error('Video changed during read; retry the explicit read.');
      return { content: [{ type: 'text', text: `Prepared an immutable video snapshot for this explicit read. Native video bytes are supplied only when supported by the selected model and request size limits. Do not claim to have viewed omitted bytes.\n${JSON.stringify(attachments)}` }],
        details: { version: 1, type: 'attachment-read', attachments } };
    },
  };
}
