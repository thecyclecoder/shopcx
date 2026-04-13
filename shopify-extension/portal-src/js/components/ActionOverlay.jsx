// components/ActionOverlay.jsx — Full-screen overlay for mutation actions
// Three states: loading (bouncing emojis), success (animated check), error (sad face)
import { createPortal } from 'preact/compat';

function LoadingContent() {
  return (
    <div class="sp-action-overlay__card">
      <div class="sp-action-overlay__emojis">
        <span class="sp-action-overlay__emoji sp-action-overlay__emoji--1">{'\ud83c\udf44'}</span>
        <span class="sp-action-overlay__emoji sp-action-overlay__emoji--2">{'\ud83c\udf4a'}</span>
        <span class="sp-action-overlay__emoji sp-action-overlay__emoji--3">{'\ud83e\uded0'}</span>
      </div>
      <div class="sp-action-overlay__title">Making changes...</div>
    </div>
  );
}

function SuccessContent({ description, onClose }) {
  return (
    <div class="sp-action-overlay__card">
      <div class="sp-action-overlay__check">
        <svg class="sp-action-overlay__check-svg" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg">
          <circle class="sp-action-overlay__check-circle" cx="26" cy="26" r="24" fill="none" stroke="#16a34a" stroke-width="3" />
          <path class="sp-action-overlay__check-mark" fill="none" stroke="#16a34a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" d="M15 27l7 7 15-15" />
        </svg>
      </div>
      <div class="sp-action-overlay__title sp-action-overlay__title--success">Changes saved!</div>
      {description && <div class="sp-action-overlay__sub">{description}</div>}
      <button type="button" class="sp-action-overlay__btn" onClick={onClose}>Close</button>
    </div>
  );
}

function ErrorContent({ onClose }) {
  return (
    <div class="sp-action-overlay__card">
      <div class="sp-action-overlay__error-icon">{'\ud83d\ude1e'}</div>
      <div class="sp-action-overlay__title sp-action-overlay__title--error">Uh oh, that didn't work.</div>
      <div class="sp-action-overlay__sub">We're submitting a ticket on your behalf so an agent can handle this for you.</div>
      <button type="button" class="sp-action-overlay__btn" onClick={onClose}>Close</button>
    </div>
  );
}

export default function ActionOverlay({ phase, description, onClose }) {
  const content = (
    <div class="sp-action-overlay">
      {phase === 'loading' && <LoadingContent />}
      {phase === 'success' && <SuccessContent description={description} onClose={onClose} />}
      {phase === 'error' && <ErrorContent onClose={onClose} />}
    </div>
  );

  return createPortal(content, document.body);
}
