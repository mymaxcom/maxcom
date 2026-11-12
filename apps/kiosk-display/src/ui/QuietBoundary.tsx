import { Component } from 'preact';
import type { ComponentChildren } from 'preact';

/** A broken content region is retried now and then; the retry may crash again and is caught again. */
const RETRY_MS = 60_000;

interface QuietState {
  failed: boolean;
}

/**
 * Inner error boundary for the rotating content region. A render error below it shows nothing at all, so the
 * clock, dates and prayer bar around it stay on screen. It does not re-announce the error (no 30 s page
 * reload, no SafeScreen), and it lives inside Main, so the next prayer phase unmounts it and the state with it.
 */
export class QuietBoundary extends Component<{ children: ComponentChildren }, QuietState> {
  override state: QuietState = { failed: false };
  private retry: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(): Partial<QuietState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('kiosk content region crashed; showing nothing there', error);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.setState({ failed: false });
    }, RETRY_MS);
  }

  override componentWillUnmount(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
