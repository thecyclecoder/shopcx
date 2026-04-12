// LinkAccountsModal.jsx — 3-step account linking modal
// Step 1: Select accounts  Step 2: Verify  Step 3: Success (auto-close after 3s)
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { postJson } from '../core/api.js';

function formatAddress(addr) {
  if (!addr) return null;
  const parts = [addr.address1, addr.city, addr.province || addr.provinceCode, addr.zip].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export default function LinkAccountsModal({ matches, onClose, onLinked }) {
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Auto-close after success
  useEffect(() => {
    if (step === 3) {
      const timer = setTimeout(() => { onClose(); if (onLinked) onLinked(); }, 3000);
      return () => clearTimeout(timer);
    }
  }, [step, onClose, onLinked]);

  // Freeze background scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleSubmit = async () => {
    setBusy(true);
    const selectedIds = Array.from(selected);
    const rejectedIds = matches.filter(m => !selected.has(m.id)).map(m => m.id);

    if (selectedIds.length === 0) {
      // No selections — reject all
      await postJson('linkAccounts', { action: 'reject_all' });
      setStep(3);
    } else {
      await postJson('linkAccounts', { action: 'link', selected_ids: selectedIds, rejected_ids: rejectedIds });
      setStep(3);
    }
    setBusy(false);
  };

  const handleRejectAll = async () => {
    setBusy(true);
    await postJson('linkAccounts', { action: 'reject_all' });
    setStep(3);
    setBusy(false);
  };

  const handleSkip = async () => {
    await postJson('linkAccounts', { action: 'skip' });
    onClose();
  };

  return (
    h('div', { class: 'sp-link-overlay', onClick: (e) => { if (e.target.classList.contains('sp-link-overlay')) handleSkip(); } },
      h('div', { class: 'sp-link-modal' },
        // Step 1: Select
        step === 1 && h('div', null,
          h('div', { class: 'sp-link-header' },
            h('div', { class: 'sp-link-icon' }, '⚠️'),
            h('h2', { class: 'sp-link-title' }, 'Multiple Accounts Detected'),
            h('p', { class: 'sp-link-desc' },
              'Our system detected that you may have multiple accounts with us. Please link them so you can manage all your subscriptions in one place.'
            ),
          ),
          h('div', { class: 'sp-link-warning' },
            'If you have orders or subscriptions under another email, linking ensures you won\'t lose access to them.'
          ),
          h('div', { class: 'sp-link-list' },
            matches.map(m =>
              h('label', { key: m.id, class: `sp-link-item ${selected.has(m.id) ? 'sp-link-item--selected' : ''}`, onClick: () => toggle(m.id) },
                h('div', { class: 'sp-link-checkbox' },
                  h('input', { type: 'checkbox', checked: selected.has(m.id), onChange: () => {} }),
                ),
                h('div', { class: 'sp-link-item-info' },
                  m.first_name || m.last_name
                    ? h('div', { class: 'sp-link-item-name' }, [m.first_name, m.last_name].filter(Boolean).join(' '))
                    : null,
                  h('div', { class: 'sp-link-item-email' }, m.email),
                  formatAddress(m.default_address)
                    ? h('div', { class: 'sp-link-item-address' }, formatAddress(m.default_address))
                    : null,
                ),
              )
            ),
          ),
          h('div', { class: 'sp-link-actions' },
            h('button', { class: 'sp-btn sp-btn-primary sp-link-btn-main', onClick: () => selected.size > 0 ? setStep(2) : handleSubmit(), disabled: busy },
              selected.size > 0 ? 'Continue' : 'None of these are mine'
            ),
            h('button', { class: 'sp-btn sp-btn--ghost sp-link-btn-skip', onClick: handleSkip }, 'Skip for now'),
          ),
          h('button', { class: 'sp-link-reject-all', onClick: handleRejectAll, disabled: busy },
            'None of these are mine'
          ),
        ),

        // Step 2: Verify
        step === 2 && h('div', null,
          h('div', { class: 'sp-link-header' },
            h('h2', { class: 'sp-link-title' }, 'Verify Your Accounts'),
            h('p', { class: 'sp-link-desc' },
              'Please confirm these accounts belong to you. They will be linked together so you can manage everything in one place.'
            ),
          ),
          h('div', { class: 'sp-link-list' },
            Array.from(selected).map(id => {
              const m = matches.find(x => x.id === id);
              if (!m) return null;
              return h('div', { key: m.id, class: 'sp-link-item sp-link-item--verified' },
                h('div', { class: 'sp-link-item-check' }, '✓'),
                h('div', { class: 'sp-link-item-info' },
                  m.first_name || m.last_name
                    ? h('div', { class: 'sp-link-item-name' }, [m.first_name, m.last_name].filter(Boolean).join(' '))
                    : null,
                  h('div', { class: 'sp-link-item-email' }, m.email),
                  formatAddress(m.default_address)
                    ? h('div', { class: 'sp-link-item-address' }, formatAddress(m.default_address))
                    : null,
                ),
              );
            }),
          ),
          h('div', { class: 'sp-link-actions' },
            h('button', { class: 'sp-btn sp-btn-primary sp-link-btn-main', onClick: handleSubmit, disabled: busy },
              busy ? 'Linking...' : 'Confirm & Link'
            ),
            h('button', { class: 'sp-btn sp-btn--ghost', onClick: () => setStep(1) }, '← Back'),
          ),
        ),

        // Step 3: Success
        step === 3 && h('div', { class: 'sp-link-success' },
          h('div', { class: 'sp-link-success-icon' }, '✅'),
          h('h2', { class: 'sp-link-title' },
            selected.size > 0 ? 'Accounts Linked!' : 'Got it!'
          ),
          h('p', { class: 'sp-link-desc' },
            selected.size > 0
              ? 'Your accounts are now linked. You can manage all your subscriptions from one place.'
              : 'We won\'t ask you about these accounts again.'
          ),
          h('div', { class: 'sp-link-auto-close' }, 'This will close automatically...'),
        ),
      )
    )
  );
}
