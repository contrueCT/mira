import { useEffect, useRef, useState } from 'react';
import { attachmentBlob, attachmentKind, attachmentSize } from './attachments.ts';
import { errorText, isAbort } from './api.ts';
import type { Attachment } from './types.ts';

function useAttachmentUrl(attachment: Attachment, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setUrl(null); setDownloadUrl(null); setError(null);
    if (!enabled) return;
    const controller = new AbortController(); let objectUrl: string | null = null; let inertUrl: string | null = null;
    void attachmentBlob(attachment, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      inertUrl = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' })); setDownloadUrl(inertUrl);
    }).catch(reason => { if (!controller.signal.aborted && !isAbort(reason)) setError(errorText(reason)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); if (inertUrl) URL.revokeObjectURL(inertUrl); };
  }, [attachment.id, attachment.mimeType, attachment.size, enabled, version]);
  return { url, downloadUrl, error, retry: () => setVersion(value => value + 1) };
}
/** Keep historical image bytes out of memory until their tile approaches the viewport. */
function useNearViewport() {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const element = ref.current; if (!element) return;
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]; if (entry) setNear(entry.isIntersecting);
    }, { rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, near };
}
export function AttachmentTile({ attachment, onPreview }: { attachment: Attachment; onPreview: (attachment: Attachment) => void }) {
  const kind = attachmentKind(attachment.mimeType);
  const [decodeError, setDecodeError] = useState(false);
  const { ref, near } = useNearViewport();
  const { url, error } = useAttachmentUrl(attachment, kind === 'image' && near);
  return <button ref={ref} type="button" className={`attachment-tile attachment-${kind}`} aria-label={`${kind === 'image' ? '预览图片' : kind === 'video' ? '预览视频' : '查看附件'} ${attachment.name}`} onClick={() => onPreview(attachment)}>
    {kind === 'image' && url && !decodeError ? <img src={url} alt={attachment.name} loading="lazy" onError={() => setDecodeError(true)} /> : <span className="attachment-symbol" aria-hidden="true">{kind === 'image' ? '▧' : kind === 'video' ? '▶' : '↧'}</span>}
    {kind !== 'image' && <span className="attachment-file-label"><strong>{attachment.name}</strong><span>{attachmentSize(attachment.size)}{kind === 'file' ? ' · 下载 / 引用' : ' · 视频'}</span></span>}
    {kind === 'image' && (!url || decodeError) && <span className="attachment-image-status">{error || decodeError ? '预览未加载，点击查看' : '正在加载图片…'}</span>}
  </button>;
}
export function AttachmentList({ attachments, onPreview }: { attachments: Attachment[]; onPreview: (attachment: Attachment) => void }) {
  return <div className="attachment-grid">{attachments.map(attachment => <AttachmentTile key={attachment.id} attachment={attachment} onPreview={onPreview} />)}</div>;
}
export function AttachmentPreview({ attachment, onClose, returnFocus }: { attachment: Attachment; onClose: () => void; returnFocus: HTMLElement | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const kind = attachmentKind(attachment.mimeType);
  const { url, downloadUrl, error, retry } = useAttachmentUrl(attachment, true);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => {
    const focus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current; dialog?.showModal();
    return () => { dialog?.close(); if (focus?.isConnected) focus.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="attachment-dialog" aria-labelledby="attachment-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="attachment-preview-header"><h2 id="attachment-title">{attachment.name}</h2><button type="button" className="icon-button" aria-label="关闭附件预览" onClick={onClose}>×</button></div>
    <div className="attachment-preview-content">
      {!url && !error && <p role="status">正在读取附件…</p>}
      {error && <div role="alert"><p>{error}</p><button className="secondary-button" onClick={retry}>重新读取</button></div>}
      {url && kind === 'image' && <><img src={url} alt={attachment.name} onError={() => setPlaybackError(true)} />{playbackError && <p role="status">此图片无法预览，请下载后查看。</p>}</>}
      {url && kind === 'video' && <><video src={url} controls playsInline preload="metadata" onError={() => setPlaybackError(true)} />{playbackError && <p role="status">此浏览器无法播放该视频，请下载后查看。</p>}</>}
      {url && kind === 'file' && <p>此文件仅作为下载和引用附件，不会在这里解析或预览内容。</p>}
    </div>
    <div className="attachment-preview-footer"><span>{attachmentSize(attachment.size)}</span>{downloadUrl && <a className="secondary-button" href={downloadUrl} download={attachment.name}>下载文件</a>}</div>
  </dialog>;
}
