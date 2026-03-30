// components/Modal.jsx — Reusable modal overlay
// Portaled to document.body to escape host stacking contexts
import { useEffect, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';

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

  const modal = (
    <div class="sp-modal" role="dialog" aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class="sp-modal__card">
        {title && (
          <div class="sp-modal__title">
            <span>{title}</span>
            <button type="button" class="sp-modal__close" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13.5 4.5L4.5 13.5M4.5 4.5L13.5 13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        )}
        <div class="sp-modal__body">{children}</div>
        {footer && <div class="sp-modal__footer">{footer}</div>}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
