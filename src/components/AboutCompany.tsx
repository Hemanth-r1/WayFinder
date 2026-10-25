/**
 * About: WayFinder, its parent TUFF Foundation and the sister company Avakasha, plus a
 * short note on what WayFinder keeps and where.
 */
import { BRAND, COLORS, FONTS } from '../brand';
import { BrandLockup } from './BrandMark';

export default function AboutCompany({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={`About ${BRAND.product.name}`} onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(460px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: COLORS.bgMid, border: `1px solid ${COLORS.border}`,
        borderRadius: 18, padding: 22, color: COLORS.text, boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}><BrandLockup size={40} /></div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: COLORS.textSoft, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <p style={{ color: COLORS.textMuted, fontSize: 14, lineHeight: 1.55, margin: '16px 0' }}>{BRAND.product.summary}</p>

        <div style={label}>{BRAND.parent.name}</div>
        <p style={{ fontSize: 13, color: COLORS.textMuted, margin: '0 0 10px' }}>
          {BRAND.product.name} is a {BRAND.parent.name} company.{' '}
          {BRAND.parent.url && <a href={BRAND.parent.url} target="_blank" rel="noopener" style={link}>Visit {BRAND.parent.name}</a>}
        </p>
        {BRAND.companies.map(c => (
          <a key={c.name} href={c.url} target="_blank" rel="noopener" style={{
            display: 'block', textDecoration: 'none', background: COLORS.surface, border: `1px solid ${COLORS.border}`,
            borderRadius: 14, padding: '10px 12px', marginBottom: 8,
          }}>
            <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 14, color: COLORS.text }}>{c.name}</div>
            <div style={{ fontSize: 12, color: COLORS.textSoft }}>{c.summary}</div>
          </a>
        ))}

        {BRAND.product.contactEmail && (
          <>
            <div style={label}>Contact</div>
            <a href={`mailto:${BRAND.product.contactEmail}`} style={link}>{BRAND.product.contactEmail}</a>
          </>
        )}

        <div style={label}>Your data</div>
        <p style={{ fontSize: 12, color: COLORS.textSoft, lineHeight: 1.55, margin: 0 }}>
          Maps, roads and signals are kept on your device so they aren't downloaded again. Saved places and your files are stored in your account.
          Junction counts are anonymous totals; real drivers' cars carry no account details.
        </p>
        <div style={{ fontSize: 11, color: COLORS.textSoft, marginTop: 16 }}>© {new Date().getFullYear()} {BRAND.parent.name}</div>
      </div>
    </div>
  );
}

const label = { fontSize: 10, color: COLORS.textSoft, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, margin: '14px 0 6px' } as const;
const link = { color: COLORS.teal, textDecoration: 'none' } as const;
