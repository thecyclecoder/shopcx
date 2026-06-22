// components/ErrorBoundary.jsx — Preact render-crash boundary for the portal.
//
// Catches an error thrown while rendering the portal subtree (a crash the global
// window.onerror wouldn't see during a Preact update), reports it to the client
// error ingest (surface 'portal'), and shows a minimal fallback instead of a
// blank screen. Part of client-error-capture spec, Phase 1.

import { Component } from 'preact';
import { reportPortalCrash } from '../core/error-reporter.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error) {
    try {
      reportPortalCrash(error);
    } catch {
      // Fail-open.
    }
  }

  render(props, state) {
    if (state.crashed) {
      return (
        <div style="padding:2rem;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
          <p style="font-weight:600;margin:0;">Something went wrong.</p>
          <p style="margin-top:0.5rem;color:#71717a;font-size:0.875rem;">Please refresh to try again.</p>
        </div>
      );
    }
    return props.children;
  }
}
