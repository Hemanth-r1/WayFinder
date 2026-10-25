/**
 * Light / dark theme (the same pair Avakasha uses). The choice is kept on the device;
 * without one, the device's setting decides. The page sets `data-theme` before the first
 * paint (index.html); colours come from CSS variables in index.css.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'wf-theme';
const EVENT = 'wf-theme';

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#eef4ff' : '#000000');
  try { localStorage.setItem(KEY, theme); } catch { /* storage blocked: this session only */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The current theme, updated when it changes. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(getTheme);
  useEffect(() => {
    const on = () => set(getTheme());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [theme, setTheme];
}
