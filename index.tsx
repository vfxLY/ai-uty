import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

console.log("Starting Application...");

// Simple Error Boundary to catch render errors
class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', color: 'red', fontFamily: 'sans-serif', textAlign: 'center', marginTop: '50px' }}>
          <h1>Something went wrong.</h1>
          <p style={{ background: '#eee', padding: '10px', borderRadius: '5px', display: 'inline-block' }}>
            {this.state.error?.message}
          </p>
          <br/>
          <button onClick={() => window.location.reload()} style={{ marginTop: '20px', padding: '10px 20px', cursor: 'pointer' }}>
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error("CRITICAL: Could not find root element to mount to");
  throw new Error("Could not find root element to mount to");
}

try {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
  console.log("Application mounted successfully.");
} catch (e) {
  console.error("Failed to mount application:", e);
}