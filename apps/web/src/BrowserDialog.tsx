import { useEffect, useRef, type RefObject } from 'react';
import { BrowserPanel } from './BrowserPanel.tsx';
import { CloseIcon } from './icons.tsx';

/** Direct header entry to Mira's own managed browser: live view, take over
 * and hand back. Same panel and protections as Settings → 浏览器. */
export function BrowserDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const cancel = (event: Event) => { event.preventDefault(); onCloseRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => {
      dialog?.removeEventListener('cancel', cancel);
      if (dialog?.open) dialog.close();
      queueMicrotask(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); });
    };
  }, [returnFocus]);
  return <dialog ref={dialogRef} className="settings-dialog browser-dialog" aria-labelledby="browser-dialog-title">
    <div className="settings-topbar"><div><span className="eyebrow">MIRA · BROWSER</span><h2 id="browser-dialog-title">浏览器</h2></div><button ref={closeRef} className="icon-button" type="button" aria-label="关闭浏览器" onClick={() => onCloseRef.current()}><CloseIcon /></button></div>
    <div className="browser-dialog-body"><BrowserPanel active preferOwner="Mira" standalone /></div>
  </dialog>;
}
