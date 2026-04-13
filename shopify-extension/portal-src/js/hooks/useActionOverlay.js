// hooks/useActionOverlay.js — Full-screen action overlay (loading → success/error)
import { useState, useCallback } from 'preact/hooks';
import ActionOverlay from '../components/ActionOverlay.jsx';

export function useActionOverlay() {
  // state: null | { phase: 'loading' } | { phase: 'success', description } | { phase: 'error' }
  const [state, setState] = useState(null);

  const startAction = useCallback(() => {
    // Close any open modals by removing sp-modal-open class
    document.body.classList.remove('sp-modal-open');
    setState({ phase: 'loading' });
  }, []);

  const completeAction = useCallback((description) => {
    setState({ phase: 'success', description: description || 'Done!' });
  }, []);

  const failAction = useCallback((error) => {
    console.error('[ActionOverlay] Action failed:', error);
    setState({ phase: 'error' });
  }, []);

  const dismiss = useCallback(() => {
    setState(null);
  }, []);

  const overlay = state
    ? ActionOverlay({ phase: state.phase, description: state.description, onClose: dismiss })
    : null;

  return { overlay, startAction, completeAction, failAction };
}
