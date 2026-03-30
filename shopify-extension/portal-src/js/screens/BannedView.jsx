// screens/BannedView.jsx — Restricted view for banned portal customers
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson } from '../core/api.js';

const SUBJECTS = [
  'Change my subscription',
  'Cancel my subscription',
  'Update shipping address',
  'Other',
];

export default function BannedView() {
  const { showToast } = useContext(PortalContext);
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    try {
      await postJson('submitBanRequest', { subject, message: message.trim() });
      setSubmitted(true);
      showToast('Your request has been submitted.', 'success');
    } catch {
      showToast('Could not submit your request. Please try again.', 'error');
    }
    setBusy(false);
  }

  if (submitted) {
    return (
      <div class="sp-wrap">
        <div class="sp-card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>{'\u2705'}</div>
          <h2 class="sp-title" style={{ marginBottom: '8px' }}>Request submitted</h2>
          <p class="sp-muted" style={{ fontSize: '17px' }}>
            We'll get back to you within 24 hours.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="sp-wrap">
      <div class="sp-card" style={{ padding: '32px 24px' }}>
        <h2 class="sp-title" style={{ marginBottom: '8px' }}>Account restricted</h2>
        <p class="sp-muted" style={{ fontSize: '17px', lineHeight: '1.5', marginBottom: '24px' }}>
          We're sorry but your account is not allowed to make self-serve changes to your subscriptions. Please use the form below to request changes.
        </p>

        <form onSubmit={handleSubmit}>
          <div class="sp-field">
            <label class="sp-field__label">What do you need help with?</label>
            <select class="sp-select" value={subject} onChange={(e) => setSubject(e.target.value)}>
              {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div class="sp-field">
            <label class="sp-field__label">Message</label>
            <textarea class="sp-input" rows={4} value={message}
              placeholder="Describe the changes you'd like to make..."
              onInput={(e) => setMessage(e.target.value)}
              style={{ resize: 'vertical', minHeight: '100px' }}
            />
          </div>

          <button type="submit" class="sp-btn sp-btn-primary" disabled={busy || !message.trim()}
            style={{ width: '100%', marginTop: '8px' }}>
            {busy ? 'Submitting\u2026' : 'Submit request'}
          </button>
        </form>
      </div>
    </div>
  );
}
