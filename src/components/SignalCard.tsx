/**
 * Live card for one signal, for every user: each direction of traffic with its light,
 * a countdown to the next change, and how long its green and red last — plus a nudge to
 * switch the engine off during long reds.
 */
import { useEffect, useState } from 'react';
import type { TrafficSignal } from '../types';
import { groupTiming, formatSeconds } from '../utils/signalTiming';

const LIGHT = { GREEN: '#00E676', YELLOW: '#FFD600', RED: '#FF1744' } as const;
/** Reds at least this long are worth switching the engine off for (s). */
const ENGINE_OFF_SECONDS = 30;

interface Props {
  signal: TrafficSignal;
  /** When this signal's live state last arrived (ms) */
  updatedAt: number;
  onClose: () => void;
  compact?: boolean;
}

export default function SignalCard({ signal, updatedAt, onClose, compact }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = Math.max(0, (now - updatedAt) / 1000);

  const arms = signal.arms ?? [];
  const groups = [...new Set(signal.phases.filter(p => p.color === 'GREEN').map(p => p.group))];
  const rows = arms.length > 0
    ? arms.map(a => ({
        key: a.edgeId, title: a.road, group: a.group,
        sub: `from the ${a.from}${a.fromJunction ? ` (${a.fromJunction})` : ''}${a.towards ? ` → towards ${a.towards}` : ''}`,
      }))
    : groups.map(g => ({ key: g, title: g === 'A' ? 'Main road' : 'Cross road', sub: '', group: g }));

  return (
    <div style={{
      position: 'absolute', zIndex: 1600,
      ...(compact ? { left: 8, right: 8, top: 8 } : { top: 12, right: 12, width: 340 }),
      background: 'rgba(8,8,18,0.96)', border: '1px solid #2a2a40', borderRadius: 12,
      padding: 12, color: '#ccc', fontFamily: 'system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>🚦 {signal.name ?? 'Traffic signal'}</div>
          <div style={{ color: '#666', fontSize: 10, fontFamily: 'monospace' }}>
            {signal.id} · cycle {signal.cycleLength} s
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: '#888', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
      </div>

      <div style={{ marginTop: 8 }}>
        {rows.map(r => {
          const t = groupTiming(signal, r.group, elapsed);
          return (
            <div key={r.key} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '1px solid #1a1a2e' }}>
              <span style={{ width: 16, height: 16, borderRadius: 8, background: LIGHT[t.light], flexShrink: 0, boxShadow: `0 0 8px ${LIGHT[t.light]}` }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>{r.title}</div>
                {r.sub && <div style={{ color: '#888', fontSize: 11 }}>{r.sub}</div>}
                <div style={{ color: '#666', fontSize: 10, marginTop: 1 }}>
                  green {formatSeconds(t.green)} · amber {formatSeconds(t.yellow)} · red {formatSeconds(t.red)} each cycle
                  {t.allRed > 0 && <> (incl. {t.allRed} s all-red clearance)</>}
                </div>
                {t.light === 'RED' && t.changesIn >= ENGINE_OFF_SECONDS && (
                  <div style={{ color: '#FFD54F', fontSize: 11, marginTop: 2 }}>⏱ Switch off your engine — green in {formatSeconds(t.changesIn)}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                <div style={{ color: LIGHT[t.light], fontSize: 16, fontWeight: 700 }}>{t.changesIn}s</div>
                <div style={{ color: '#666', fontSize: 9 }}>{t.light === 'RED' ? 'until green' : t.light === 'GREEN' ? 'until amber' : 'until red'}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
