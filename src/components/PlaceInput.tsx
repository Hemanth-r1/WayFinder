import { useEffect, useRef, useState } from 'react';
import type { RoadGraph } from '../types';
import { searchPlaces, type Place } from '../utils/places';

interface Props {
  graph: RoadGraph;
  /** Name of the chosen place, shown when not editing */
  value: string | null;
  placeholder: string;
  dotColor: string;
  onPick: (place: Place) => void;
  onClear: () => void;
  /** Shows a "use my location" button when provided */
  onUseLocation?: () => void;
  locating?: boolean;
  autoFocus?: boolean;
}

/** Search box with road/address suggestions. */
export default function PlaceInput({
  graph, value, placeholder, dotColor, onPick, onClear, onUseLocation, locating, autoFocus,
}: Props) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search (the OSM geocoder allows ~1 request/second)
  useEffect(() => {
    if (!editing || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      searchPlaces(graph, query, controller.signal)
        .then(r => { setResults(r); setActive(0); })
        .catch(() => {})
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [graph, query, editing]);

  const pick = (place: Place) => {
    onPick(place);
    setEditing(false);
    setQuery('');
    setResults([]);
    inputRef.current?.blur();
  };

  const showValue = value && !editing;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, background: '#1a1a2e',
        border: `1px solid ${editing ? '#4488FF' : '#2a2a40'}`, borderRadius: 8, padding: '0 10px', height: 44,
      }}>
        <span style={{ color: dotColor, fontSize: 14 }}>●</span>
        <input
          ref={inputRef}
          value={showValue ? value : query}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onFocus={() => { setEditing(true); setQuery(''); }}
          onBlur={() => setTimeout(() => setEditing(false), 150)}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && results[active]) pick(results[active]);
            if (e.key === 'Escape') inputRef.current?.blur();
          }}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: showValue ? '#fff' : '#ccc', fontSize: 14,
          }}
        />
        {onUseLocation && !value && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={onUseLocation}
            disabled={locating}
            title="Use my current location"
            style={{
              background: 'none', border: 'none', color: '#4488FF', cursor: 'pointer',
              fontSize: 12, fontWeight: 'bold', padding: 0, whiteSpace: 'nowrap',
            }}
          >{locating ? 'Locating…' : '◎ My location'}</button>
        )}
        {value && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => { onClear(); setQuery(''); }}
            title="Clear"
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16, padding: 0 }}
          >✕</button>
        )}
      </div>

      {editing && (results.length > 0 || searching) && (
        <div style={{
          position: 'absolute', top: 48, left: 0, right: 0, zIndex: 3000,
          background: '#141426', border: '1px solid #333', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}>
          {results.map((r, i) => (
            <div
              key={`${r.source}-${r.label}-${r.lat}`}
              onMouseDown={e => { e.preventDefault(); pick(r); }}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid #222',
                background: i === active ? '#4488FF22' : 'transparent',
              }}
            >
              <div style={{ fontSize: 13, color: '#fff' }}>{r.source === 'road' ? '🛣️ ' : '📍 '}{r.label}</div>
              {r.detail && <div style={{ fontSize: 11, color: '#777', marginTop: 1 }}>{r.detail}</div>}
            </div>
          ))}
          {searching && <div style={{ padding: '8px 12px', fontSize: 11, color: '#777' }}>Searching…</div>}
        </div>
      )}
    </div>
  );
}
