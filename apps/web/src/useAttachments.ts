import { useEffect, useRef, useState } from 'react';
import { errorText } from './api.ts';
import { uploadAttachment, validateSelection } from './attachments.ts';
import type { Attachment } from './types.ts';
export interface DraftAttachment { key: string; file: File; controller: AbortController; attachment?: Attachment; error?: string | undefined }
/** Files are transient. Only the immutable submitted attachment IDs enter session storage. */
export function useAttachments() {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const ref = useRef<DraftAttachment[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const draft of ref.current) draft.controller.abort(); }; }, []);
  const update = (values: DraftAttachment[]) => { ref.current = values; if (mounted.current) setDrafts(values); };
  const upload = (draft: DraftAttachment) => {
    void uploadAttachment(draft.file, draft.controller.signal).then(attachment => {
      if (!draft.controller.signal.aborted) update(ref.current.map(item => item.key === draft.key ? { ...item, attachment, error: undefined } : item));
    }).catch(error => {
      if (!draft.controller.signal.aborted) update(ref.current.map(item => item.key === draft.key ? { ...item, error: errorText(error) } : item));
    });
  };
  const add = (files: File[]) => {
    const error = validateSelection(ref.current.map(item => item.file), files); if (error) return error;
    const added = files.map(file => ({ key: crypto.randomUUID(), file, controller: new AbortController() }));
    update([...ref.current, ...added]); for (const draft of added) upload(draft); return null;
  };
  const remove = (key: string) => { ref.current.find(item => item.key === key)?.controller.abort(); update(ref.current.filter(item => item.key !== key)); };
  const retry = (key: string) => {
    const draft = ref.current.find(item => item.key === key); if (!draft) return;
    draft.controller.abort(); const next = { ...draft, controller: new AbortController(), error: undefined };
    update(ref.current.map(item => item.key === key ? next : item)); upload(next);
  };
  const clear = () => { for (const draft of ref.current) draft.controller.abort(); update([]); };
  return { drafts, add, remove, retry, clear, ready: drafts.every(draft => !!draft.attachment), attachments: drafts.flatMap(draft => draft.attachment ? [draft.attachment] : []) };
}
