import { useEffect, useRef, type RefObject } from 'react';
import { BrowserPanel } from './BrowserPanel.tsx';

/** Direct header entry to Mira's own managed browser: near-fullscreen on
 * desktop, fullscreen on phones. Same panel and protections as Settings →
 * 浏览器. The panel moves focus to its primary action once it is known. */
export function BrowserDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLButtonElement>('.bp-head button[aria-label="关闭浏览器"]')?.focus();
    const cancel = (event: Event) => { event.preventDefault(); onCloseRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => {
      dialog?.removeEventListener('cancel', cancel);
      if (dialog?.open) dialog.close();
      queueMicrotask(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); });
    };
  }, [returnFocus]);
  return <dialog ref={dialogRef} className="browser-dialog" aria-labelledby="browser-dialog-title">
    <BrowserPanel active preferOwner="Mira" standalone onClose={() => onCloseRef.current()} />
  </dialog>;
}
