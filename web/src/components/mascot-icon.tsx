// The mascot as a small still icon (sidebar, headers, avatars): the transparent render of the 3D model.
// Kept apart from mascot.tsx so these places do not load three.js.
import Image from 'next/image';

export const MASCOT_POSTER = '/brand/assistant-mascot.png';

/** Drop-in for a lucide icon in the navigation (same props it receives). */
export function MascotIcon({ className = '' }: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) {
  return <Image src={MASCOT_POSTER} alt="" width={24} height={24} className={`mascot-icon ${className}`} aria-hidden />;
}
