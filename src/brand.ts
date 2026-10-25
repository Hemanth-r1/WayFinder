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

/** Shared look with Avakasha (dark theme values of its design tokens). */
export const COLORS = {
  bgDeep: '#000000',
  bgMid: '#0a0a0d',
  surface: '#16161a',
  border: '#26262e',
  text: '#e8f2ff',
  textMuted: '#a8bdd1',
  textSoft: '#7a95b0',
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
