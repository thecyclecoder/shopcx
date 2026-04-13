// modals/QuantityModal.jsx — Change item quantity
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr } from '../core/utils.js';
import Modal from '../components/Modal.jsx';

export default function QuantityModal({ contract, line, onClose, onDone, onPatchLines }) {
  const { showToast, startAction, completeAction, failAction } = useContext(PortalContext);
  const initialQty = line?.quantity || 1;
  const [qty, setQty] = useState(initialQty);
  const [busy, setBusy] = useState(false);

  const img = line?.variantImage?.transformedSrc || '';
  const title = safeStr(line?.title) || 'Item';
  const flavor = safeStr(line?.variantTitle);

  async function save() {
    if (qty === initialQty) {
      showToast('Quantity updated.', 'success');
      onClose();
      return;
    }
    setBusy(true);
    onClose();
    startAction();
    try {
      const resp = await postJson('replaceVariants', {
        contractId: contract.id,
        oldLineId: safeStr(line?.id),
        newVariants: [{ variantId: safeStr(line?.variantId), quantity: qty }],
      });
      completeAction('Quantity updated!');
      clearCaches();
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines) && onPatchLines) {
        onPatchLines(resp.patch.lines);
      } else {
        onDone?.();
      }
    } catch (e) {
      failAction(e?.message || 'Could not update quantity.');
    }
  }

  return (
    <Modal title="Change quantity" onClose={onClose} footer={
      <><button class="sp-btn sp-btn-primary" disabled={busy} onClick={save}>Submit</button>
      <button class="sp-btn sp-btn--ghost" onClick={onClose}>Cancel</button></>
    }>
      <div class="sp-note sp-addswap-note">
        <div class="sp-note__title">Choose quantity</div>
        <div class="sp-note__body">Update how many you receive, then submit.</div>
      </div>
      <div class="sp-addswap-selected">
        {img ? <img class="sp-addswap-selected__img" src={img} alt={title} />
             : <div class="sp-addswap-selected__img sp-addswap-selected__img--placeholder" />}
        <div class="sp-addswap-selected__text">
          <div class="sp-addswap-selected__title">{title}</div>
          {flavor && <div class="sp-addswap-selected__headline sp-muted">{flavor}</div>}
        </div>
      </div>
      <div class="sp-addswap-qty">
        <div class="sp-addswap-qty__label">Quantity</div>
        <select class="sp-select" value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)}>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>
    </Modal>
  );
}
