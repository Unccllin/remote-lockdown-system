import React from 'react';

/**
 * Error Boundary — catches unhandled React render errors and shows a
 * fallback UI instead of crashing the entire app.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-300">
          <div className="max-w-md text-center space-y-4">
            <h1 className="text-xl font-semibold text-slate-200">Something went wrong</h1>
            <p className="text-sm text-slate-500">
              An unexpected error occurred. Try refreshing the page.
            </p>
            <pre className="text-xs text-red-400 bg-slate-900 rounded-lg p-3 overflow-auto max-h-40 text-left">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              Refresh
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
