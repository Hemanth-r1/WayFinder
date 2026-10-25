/**
 * WayFinder's mark: a navigation arrow in the two-tone red and amber of the TUFF
 * Foundation companies' identity (shared with Avakasha), plus the wordmark.
 */
import type { CSSProperties } from 'react';
import { BRAND, COLORS, FONTS } from '../brand';

export function BrandMark({ size = 28, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`${BRAND.product.name} logo`} style={{ flexShrink: 0, ...style }}>
      <polygon points="32,5 9,59 32,45" fill={COLORS.markRed} />
      <polygon points="32,5 55,59 32,45" fill={COLORS.markAmber} />
    </svg>
  );
}

/** Logo + "WayFinder" + "by TUFF Foundation". */
export function BrandLockup({ size = 28, light = false, showParent = true }: { size?: number; light?: boolean; showParent?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.32 }}>
      <BrandMark size={size} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
        <span style={{ fontFamily: FONTS.display, fontWeight: 800, fontSize: size * 0.62, letterSpacing: '-0.01em', color: light ? '#0b1b33' : COLORS.text }}>
          {BRAND.product.name}
        </span>
        {showParent && (
          <span style={{ fontFamily: FONTS.body, fontSize: Math.max(9, size * 0.32), fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: light ? '#3b4f6b' : COLORS.textSoft }}>
            by {BRAND.parent.name}
          </span>
        )}
      </span>
    </span>
  );
}
