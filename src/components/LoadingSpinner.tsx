import type { CSSProperties } from 'react';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  color?: string;
  text?: string;
  fullScreen?: boolean;
}

export function LoadingSpinner({ 
  size = 'medium', 
  color = '#FF6D00',
  text = 'Loading...',
  fullScreen = false 
}: LoadingSpinnerProps) {
  const sizeMap = {
    small: { spinner: 20, fontSize: 12 },
    medium: { spinner: 30, fontSize: 14 },
    large: { spinner: 50, fontSize: 16 }
  };

  const dimensions = sizeMap[size];

  const spinnerStyle: CSSProperties = {
    width: dimensions.spinner,
    height: dimensions.spinner,
    border: `4px solid #333`,
    borderTop: `4px solid ${color}`,
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  };

  const containerStyle: CSSProperties = fullScreen ? {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a14',
    color: '#fff',
    fontFamily: 'system-ui',
    flexDirection: 'column' as const,
    gap: 16,
  } : {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column' as const,
    gap: 12,
  };

  return (
    <div style={containerStyle}>
      <div style={spinnerStyle} />
      {text && (
        <div style={{
          fontSize: dimensions.fontSize,
          fontWeight: 'bold',
          color: '#fff',
          textAlign: 'center' as const,
        }}>
          {text}
        </div>
      )}
      <style>{`
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export function LoadingOverlay({ message = 'Initializing simulation...' }: { message?: string }) {
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(10,10,20,0.95)',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 20,
      color: '#fff',
      fontFamily: 'system-ui',
    }}>
      <LoadingSpinner size="large" color="#FF6D00" text="" />
      <div style={{ fontSize: 18, fontWeight: 'bold' }}>WayFinder</div>
      <div style={{ fontSize: 14, color: '#888', textAlign: 'center' }}>{message}</div>
    </div>
  );
}