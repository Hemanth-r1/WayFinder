import { useEffect, useState } from 'react';

const QUERY = '(max-width: 768px)';

/** True on phone-sized viewports; updates on resize/rotation. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
