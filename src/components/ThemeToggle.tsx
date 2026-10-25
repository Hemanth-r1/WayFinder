/** Switches between light and dark mode (kept on this device). */
import { useTheme } from '../theme';

export default function ThemeToggle({ size = 32 }: { size?: number }) {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      style={{
        width: size, height: size, borderRadius: 999, display: 'grid', placeItems: 'center', flexShrink: 0,
        background: 'var(--wf-surface)', border: '1px solid var(--wf-border)', color: 'var(--wf-text)',
        cursor: 'pointer', fontSize: size * 0.48, lineHeight: 1, padding: 0,
      }}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
