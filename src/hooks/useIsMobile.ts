import { useEffect, useState } from 'react';

/** Whether a CSS media query matches; updates on resize/rotation. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** True on phone-sized viewports. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 768px)');
}
