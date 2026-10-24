import type { ReportType } from '../services/serverClient';

export const REPORT_LABEL: Record<ReportType, { icon: string; label: string; question: string }> = {
  block: { icon: '🚧', label: 'Road blocked', question: 'Is the road still blocked?' },
  tree: { icon: '🌳', label: 'Fallen tree', question: 'Is the fallen tree still there?' },
  waterlogging: { icon: '🌊', label: 'Waterlogging', question: 'Is it still waterlogged?' },
  rain: { icon: '🌧', label: 'Heavy rain', question: 'Still raining heavily?' },
};
