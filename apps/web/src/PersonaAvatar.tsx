import { useEffect, useState } from 'react';
import { avatarBlob, ringColors, personaRings, type Identity, type PersonaRing } from './persona.ts';

/** Object URL for a protected avatar image; null while loading, absent or failed. */
export function useAvatarUrl(id: string | null): string | null {
  const [url, setUrl] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!id) { setUrl(null); return; }
    const controller = new AbortController(); let objectUrl: string | null = null;
    void avatarBlob(id, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl({ id, url: objectUrl });
    }).catch(() => { if (!controller.signal.aborted) setUrl(null); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return url && url.id === id ? url.url : null;
}
export const ringColor = (ring: string | undefined): string => (personaRings as readonly string[]).includes(ring ?? '') ? ringColors[ring as PersonaRing] : ringColors.lavender;

/** The header/chat identity mark: an uploaded image inside a thin ring, or the plain colored ring. */
export function PersonaAvatar({ identity, className = 'mira-ring', url: shared }: { identity: Identity; className?: string; url?: string | null }) {
  // A caller rendering many marks loads the image once and shares its object URL.
  const own = useAvatarUrl(shared === undefined ? identity.avatar : null);
  const url = shared === undefined ? own : shared;
  const color = ringColor(identity.ring);
  return <div className={`${className}${url ? ' has-avatar' : ''}`} aria-hidden="true" style={{ borderColor: color }} data-ring={identity.ring}>
    {url && <img src={url} alt="" draggable={false} />}
  </div>;
}
