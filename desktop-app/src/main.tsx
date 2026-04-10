import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    return { error: normalized }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#e5534b', background: '#1a1a2e', height: '100vh' }}>
          <h2 style={{ marginBottom: 16 }}>应用出现异常</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#aaa' }}>{this.state.error.message}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 20, padding: '8px 16px', cursor: 'pointer', border: '1px solid #555', background: '#2a2a3e', color: '#fff' }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
