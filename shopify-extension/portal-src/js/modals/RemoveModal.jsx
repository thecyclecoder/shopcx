// modals/RemoveModal.jsx — Confirm item removal
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr } from '../core/utils.js';
import Modal from '../components/Modal.jsx';

export default function RemoveModal({ contract, line, onClose, onDone, onPatchLines, onSwapInstead }) {
  const { showToast } = useContext(PortalContext);
  const [busy, setBusy] = useState(false);

  const img = line?.variantImage?.transformedSrc || '';
  const title = safeStr(line?.title) || 'Item';
  const flavor = safeStr(line?.variantTitle);

  async function doRemove() {
    setBusy(true);
    try {
      const resp = await postJson('replaceVariants', {
        contractId: contract.id,
        oldLineId: safeStr(line?.id),
        allowRemoveWithoutAdd: true,
      });
      showToast('Item removed.', 'success');
      clearCaches();
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines) && onPatchLines) {
        onPatchLines(resp.patch.lines);
      } else {
        onDone?.();
      }
      onClose();
    } catch (e) {
      showToast(e?.message || 'Could not remove item.', 'error');
      setBusy(false);
    }
  }

  return (
    <Modal title="Remove item" onClose={onClose} footer={
      <>
        <button class="sp-btn sp-btn-primary" disabled={busy} onClick={doRemove}>Remove</button>
        {onSwapInstead && <button class="sp-btn sp-btn--ghost" onClick={() => { onClose(); onSwapInstead(); }}>Swap instead</button>}
        <button class="sp-btn sp-btn--ghost" onClick={onClose}>Cancel</button>
      </>
    }>
      <div class="sp-note sp-addswap-note">
        <div class="sp-note__title">Confirm removal</div>
        <div class="sp-note__body">You're about to remove this item from your subscription.</div>
      </div>
      <div class="sp-addswap-selected">
        {img ? <img class="sp-addswap-selected__img" src={img} alt={title} />
             : <div class="sp-addswap-selected__img sp-addswap-selected__img--placeholder" />}
        <div class="sp-addswap-selected__text">
          <div class="sp-addswap-selected__title">{title}</div>
          {flavor && <div class="sp-addswap-selected__headline sp-muted">{flavor}</div>}
        </div>
      </div>
    </Modal>
  );
}
