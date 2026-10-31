import { useEffect, useState } from 'react';
import { avatarBlob, avatarMark, type Identity } from './persona.ts';

export interface AvatarImage { url: string | null; failed: boolean }
/** Object URL for a protected avatar image, plus whether loading it failed. */
export function useAvatarImage(id: string | null): AvatarImage {
  const [state, setState] = useState<{ id: string; url: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!id) { setState(null); return; }
    const controller = new AbortController(); let objectUrl: string | null = null;
    setState({ id, url: null, failed: false });
    void avatarBlob(id, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setState({ id, url: objectUrl, failed: false });
    }).catch(() => { if (!controller.signal.aborted) setState({ id, url: null, failed: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return state && state.id === id ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

/** The identity mark: the uploaded image alone, or the coloured ring — never both. */
export function PersonaAvatar({ identity, className = 'mira-ring', image: shared }: { identity: Identity; className?: string; image?: AvatarImage }) {
  // A caller rendering many marks loads the image once and shares it.
  const own = useAvatarImage(shared === undefined ? identity.avatar : null);
  const image = shared ?? own;
  const mark = avatarMark(identity.ring, identity.avatar, image.url, image.failed);
  return <div className={`${className}${mark.mode === 'ring' ? '' : ' has-avatar'}${mark.mode === 'pending' ? ' avatar-pending' : ''}`} aria-hidden="true"
    style={mark.mode === 'ring' ? { borderColor: mark.color } : undefined} data-mark={mark.mode} data-ring={identity.ring}>
    {mark.mode === 'image' && <img src={mark.url} alt="" draggable={false} />}
  </div>;
}
