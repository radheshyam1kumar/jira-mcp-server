import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dashboard]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            padding: 24,
            background: '#F5F7F9',
            color: '#991b1b',
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            fontSize: 14,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <h1 style={{ color: '#002E7E', fontSize: 18, marginTop: 0 }}>Something went wrong</h1>
          <p style={{ color: '#334155' }}>{this.state.error.message}</p>
          <button
            type="button"
            style={{
              marginTop: 16,
              padding: '10px 16px',
              borderRadius: 10,
              border: 'none',
              background: '#00BAF2',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
