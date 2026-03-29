// components/Modal.jsx — Reusable modal overlay
// Uses existing .sp-modal CSS class names from _modal.scss
import { useEffect, useCallback } from 'preact/hooks';

export default function Modal({ title, onClose, children, footer }) {
  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('sp-modal-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('sp-modal-open');
    };
  }, [onKeyDown]);

  return (
    <div class="sp-modal" role="dialog" aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class="sp-modal__card">
        {title && (
          <div class="sp-modal__title">
            <span>{title}</span>
            <button type="button" class="sp-modal__close" onClick={onClose} aria-label="Close">{'\u2715'}</button>
          </div>
        )}
        <div class="sp-modal__body">{children}</div>
        {footer && <div class="sp-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
