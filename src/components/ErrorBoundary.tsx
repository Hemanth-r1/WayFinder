import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('WayFinder Error Boundary caught:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div style={styles.container}>
          <div style={styles.content}>
            <div style={styles.title}>🚧 Something went wrong</div>
            <div style={styles.subtitle}>WayFinder encountered an unexpected error</div>
            {this.state.error && (
              <div style={styles.errorDetails}>
                <div style={styles.errorTitle}>{this.state.error.name}</div>
                <div style={styles.errorMessage}>{this.state.error.message}</div>
              </div>
            )}
            <button onClick={this.handleReset} style={styles.resetButton}>
              Try Again
            </button>
            <button 
              onClick={() => window.location.reload()} 
              style={styles.reloadButton}
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles = {
  container: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a14',
    color: '#fff',
    fontFamily: 'system-ui, sans-serif',
  },
  content: {
    background: 'rgba(20,20,35,0.95)',
    border: '1px solid #333',
    borderRadius: 12,
    padding: '32px 40px',
    textAlign: 'center' as const,
    maxWidth: 500,
    width: '90%',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 12,
    color: '#FF6D00',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
  },
  errorDetails: {
    background: '#1a1a2e',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '16px',
    marginBottom: 24,
    textAlign: 'left' as const,
    fontFamily: 'monospace',
  },
  errorTitle: {
    color: '#FF1744',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  errorMessage: {
    color: '#ccc',
    fontSize: 11,
    wordBreak: 'break-word' as const,
  },
  resetButton: {
    padding: '12px 24px',
    background: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 'bold',
    marginRight: 12,
  },
  reloadButton: {
    padding: '12px 24px',
    background: 'transparent',
    color: '#888',
    border: '1px solid #444',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    marginLeft: 12,
  },
};