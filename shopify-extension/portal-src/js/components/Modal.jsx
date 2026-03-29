// components/Modal.jsx — Reusable modal overlay
import { useEffect, useCallback } from 'preact/hooks';

export default function Modal({ title, onClose, children, footer }) {
  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onKeyDown]);

  return (
    <div class="sp-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class="sp-modal-card" role="dialog" aria-modal="true">
        {title && (
          <div class="sp-modal-title">
            <span>{title}</span>
            <button type="button" class="sp-modal-close" onClick={onClose} aria-label="Close">{'\u2715'}</button>
          </div>
        )}
        <div class="sp-modal-body">{children}</div>
        {footer && <div class="sp-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
