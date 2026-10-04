import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../i18n-context';

/**
 * Keeps one broken panel from taking down the window.
 *
 * Without this, a single unguarded property access anywhere in the tree
 * unmounts the whole app: the user gets a blank window, the session keeps
 * running in Main, and there is nothing on screen to click. That is the worst
 * possible failure for a tool whose entire premise is that you can trust what
 * it shows you — and it is what made "上下文" render an empty black screen
 * instead of an error.
 *
 * The boundary is deliberately *per surface*, not global: the conversation,
 * the session list and the status bar must survive anything that happens
 * inside a pane, because they are how the user gets out of the pane.
 */

interface Props {
  /** Shown in the fallback so the user knows what failed. */
  label: string;
  children: ReactNode;
  /** Changing this value (e.g. a retry counter) clears the error. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  message: string;
  stack: string;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: null, message: '', stack: '' };

  static getDerivedStateFromError(error: unknown): State {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      error: err,
      message: err.message || 'Unknown error',
      // The stack is shown in a collapsed <details> rather than dumped inline:
      // it is useful for a bug report and noise for ordinary use.
      stack: err.stack ?? '',
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the DOM as well as logged: this is the only place a renderer
    // crash is recorded, and Main has no view of the renderer's stack.
    console.error('[ucad] panel render failed', this.props.label, error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, message: '', stack: '' });
    }
  }

  private retry = (): void => {
    this.setState({ error: null, message: '', stack: '' });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <PanelCrash label={this.props.label} message={this.state.message} stack={this.state.stack} onRetry={this.retry} />;
  }
}

function PanelCrash({
  label,
  message,
  stack,
  onRetry,
}: {
  label: string;
  message: string;
  stack: string;
  onRetry: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('error.panelTitle', { label })}</h1>
      </div>
      {/*
        The reason is stated, never a blank pane: a failure the user cannot see
        is the same as the silent `.catch {}` this repo keeps removing
        one this repository keeps removing. The surrounding panes stay alive, so this is a
        notice inside a working application rather than a dead window.
      */}
      <div className="notice error">
        <div style={{ overflowWrap: 'anywhere' }}>{message}</div>
      </div>
      <div className="row-gap" style={{ marginTop: 12 }}>
        <button className="primary" onClick={onRetry}>
          {t('error.retry')}
        </button>
      </div>
      {stack && (
        <details className="panel-stack">
          <summary>{t('error.copyDetail')}</summary>
          <pre className="code">{stack}</pre>
        </details>
      )}
    </div>
  );
}
