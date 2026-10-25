/**
 * Brand and company details in one place. WayFinder is a TUFF Foundation company; its
 * sister company is Avakasha Recruitment Services, whose look (colours, fonts, shapes)
 * WayFinder shares. Contact fields are shown only once they are filled in.
 */
export const BRAND = {
  parent: {
    name: 'TUFF Foundation',
    /** e.g. 'https://…' — shown as a link when set */
    url: '',
  },
  product: {
    name: 'WayFinder',
    tagline: 'Smart traffic and navigation for Bengaluru',
    summary: 'Live traffic, adaptive signals, police signal control, emergency green corridors and navigation that spreads drivers across the city.',
    contactEmail: '',
  },
  companies: [
    {
      name: 'WayFinder',
      summary: 'Smart traffic and navigation for Bengaluru',
      url: 'https://project-7d0d26b8-5887-43f6-804.web.app/',
    },
    {
      name: 'Avakasha Recruitment Services',
      summary: 'Jobs, hiring and campus placement in India',
      url: 'https://www.avakasha.in/',
    },
  ],
} as const;

/** Shared look with Avakasha. Surfaces and text follow the light / dark theme (index.css); accents are fixed. */
export const COLORS = {
  bgDeep: 'var(--wf-bg-deep)',
  bgMid: 'var(--wf-bg)',
  surface: 'var(--wf-surface)',
  border: 'var(--wf-border)',
  text: 'var(--wf-text)',
  textMuted: 'var(--wf-muted)',
  textSoft: 'var(--wf-soft)',
  /** Link text: bright teal on dark, deep teal on light (readable on both) */
  link: 'var(--wf-link)',
  teal: '#2fe4cc',
  blue: '#4f8ef7',
  amber: '#fbbf24',
  coral: '#ff7a59',
  purple: '#a78bfa',
  /** Logo colours (the red and amber of the Avakasha mark) */
  markRed: '#ff1f1f',
  markAmber: '#ffc000',
  gradientCta: 'linear-gradient(115deg, #2fe4cc 0%, #4f8ef7 55%, #fbbf24 100%)',
  gradientTitle: 'linear-gradient(115deg, #2fe4cc 0%, #60a5fa 50%, #fbbf24 100%)',
} as const;

export const FONTS = {
  body: "'Inter', system-ui, -apple-system, sans-serif",
  display: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif",
} as const;
