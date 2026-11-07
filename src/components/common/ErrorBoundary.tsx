import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertOctagon, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('DevForge renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-background p-8">
          <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-6 text-center shadow-card">
            <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
              <AlertOctagon className="size-5" />
            </div>
            <h1 className="mt-4 text-base font-semibold">The interface hit an unexpected error</h1>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              Your installations and environment settings were not changed by this crash. Reload the window to
              continue.
            </p>
            <pre className="mt-4 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/40 p-3 text-left font-mono text-[10px] leading-4 text-muted-foreground">
              {this.state.error.message}
            </pre>
            <Button className="mt-4" onClick={() => window.location.reload()}>
              <RotateCcw />
              Reload application
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
