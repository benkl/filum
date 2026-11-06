// The last line of defence: an error while drawing the interface shows this
// instead of a blank window, with a way back that doesn't lose the design
// (or, if the design itself is what breaks it, a way to start afresh).

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useStore } from "../store";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Filum:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = () => this.setState({ error: null });
    const undo = () => {
      useStore.getState().undo();
      retry();
    };
    const fresh = () => {
      localStorage.removeItem("filum.autosave");
      localStorage.removeItem("filum.autosave.dirty");
      location.reload();
    };
    return (
      <div className="crash" role="alert">
        <h2>Something went wrong</h2>
        <p>The editor ran into an error. Your design is still here: undo the last step, or try again.</p>
        <pre>{error.message}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={undo}>
            Undo and continue
          </button>
          <button className="btn" onClick={retry}>
            Try again
          </button>
          <button className="btn ghost" onClick={fresh} title="Forgets the autosaved design and starts with an empty one">
            Start afresh
          </button>
        </div>
      </div>
    );
  }
}
