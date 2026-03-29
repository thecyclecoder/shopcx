// assets/portal-actions-change-shipping-address.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';
  var RECENT_SHIP_KEY_PREFIX = '__sp_recent_shipaddr__';

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  function trackAction(actionName, extra) {
    try {
      var a = getAnalytics();
      if (!a || typeof a.portalAction !== 'function') return;
      a.portalAction(actionName, extra || {});
    } catch (e) {}
  }

  function trackActionResult(actionName, ok, extra) {
    try {
      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;
      a.send(
        'portal_action_result',
        Object.assign(
          { action: String(actionName || ''), status: ok ? 'success' : 'error' },
          extra || {}
        )
      );
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // tiny helpers
  // ---------------------------------------------------------------------------

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function requiredTrim(v) {
    return String(v == null ? '' : v).trim();
  }

  function toStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function shallowClone(obj) {
    var out = {};
    for (var k in obj || {}) out[k] = obj[k];
    return out;
  }

  // ---------------------------------------------------------------------------
  // session cache helpers (subscriptions cache)
  // - IMPORTANT: refresh TTL to 10 mins by bumping entry.ts on every write
  // ---------------------------------------------------------------------------

  function looksLikeSubsCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!entry.ts || typeof entry.ts !== 'number') return false;
    if (!entry.data || typeof entry.data !== 'object') return false;
    if (entry.data.ok !== true) return false;
    if (!Array.isArray(entry.data.contracts)) return false;
    return true;
  }

  function readSubsCacheEntry() {
    try {
      var raw = sessionStorage.getItem(SUBS_CACHE_KEY);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!looksLikeSubsCacheEntry(entry)) return null;
      return entry;
    } catch (e) {
      return null;
    }
  }

  function writeSubsCacheEntry(entry) {
    try {
      entry.ts = Date.now(); // refresh TTL
      sessionStorage.setItem(SUBS_CACHE_KEY, JSON.stringify(entry));
      return true;
    } catch (e) {
      return false;
    }
  }

  function getContractFromCacheByGid(contractGid) {
    try {
      var cid = String(shortId(contractGid));
      if (!cid) return null;

      var entry = readSubsCacheEntry();
      if (!entry) return null;

      var list = entry.data.contracts;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.id) continue;
        if (String(shortId(c.id)) === cid) return c;
      }
    } catch (e) {}
    return null;
  }

  function upsertContractIntoCache(contract) {
    try {
      if (!contract || !contract.id) return false;
      var cid = String(shortId(contract.id));
      if (!cid) return false;

      var entry = readSubsCacheEntry();
      if (!entry) return false;

      var list = entry.data.contracts;
      var replaced = false;

      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.id) continue;
        if (String(shortId(c.id)) === cid) {
          list[i] = contract;
          replaced = true;
          break;
        }
      }

      if (!replaced) list.push(contract);

      return writeSubsCacheEntry(entry);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // "recent change" storage (optional UX note later)
  // ---------------------------------------------------------------------------

  function recentShipKey(contractGid) {
    return RECENT_SHIP_KEY_PREFIX + String(shortId(contractGid) || '');
  }

  function formatAddressLine(payload) {
    var first = requiredTrim(payload.firstName);
    var last = requiredTrim(payload.lastName);

    var a1 = requiredTrim(payload.address1);
    var a2 = requiredTrim(payload.address2);
    var city = requiredTrim(payload.city);
    var st = requiredTrim(payload.provinceCode);
    var zip = requiredTrim(payload.zip);

    var name = [first, last].filter(Boolean).join(' ');
    var line1 = a1 + (a2 ? ', ' + a2 : '');
    var line2 = [city, st, zip].filter(Boolean).join(' ');

    return [name, line1, line2].filter(Boolean).join(' • ');
  }

  function saveRecentAddress(contractGid, payload) {
    try {
      var clean = {
        firstName: requiredTrim(payload.firstName),
        lastName: requiredTrim(payload.lastName),
        address1: requiredTrim(payload.address1),
        address2: requiredTrim(payload.address2),
        city: requiredTrim(payload.city),
        provinceCode: requiredTrim(payload.provinceCode),
        zip: requiredTrim(payload.zip),
        countryCode: requiredTrim(payload.countryCode),
        country: requiredTrim(payload.country),
      };

      sessionStorage.setItem(
        recentShipKey(contractGid),
        JSON.stringify({
          ts: Date.now(),
          text: formatAddressLine(clean),
          payload: clean,
        })
      );
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Pull logged-in customer name from the root div data attributes
  // ---------------------------------------------------------------------------

  function getCustomerFromRoot() {
    var root = document.querySelector('.subscriptions-portal');
    if (!root) return {};
    return {
      firstName: root.getAttribute('data-first-name') || '',
      lastName: root.getAttribute('data-last-name') || '',
    };
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  function stateSelect(ui, label, value, required) {
    var select = ui.el('select', { class: 'sp-select' }, []);

    if (required) {
      select.setAttribute('required', 'required');
      select.setAttribute('aria-required', 'true');
    }

    var states = [
      ['AL', 'Alabama'],
      ['AK', 'Alaska'],
      ['AZ', 'Arizona'],
      ['AR', 'Arkansas'],
      ['CA', 'California'],
      ['CO', 'Colorado'],
      ['CT', 'Connecticut'],
      ['DE', 'Delaware'],
      ['FL', 'Florida'],
      ['GA', 'Georgia'],
      ['HI', 'Hawaii'],
      ['ID', 'Idaho'],
      ['IL', 'Illinois'],
      ['IN', 'Indiana'],
      ['IA', 'Iowa'],
      ['KS', 'Kansas'],
      ['KY', 'Kentucky'],
      ['LA', 'Louisiana'],
      ['ME', 'Maine'],
      ['MD', 'Maryland'],
      ['MA', 'Massachusetts'],
      ['MI', 'Michigan'],
      ['MN', 'Minnesota'],
      ['MS', 'Mississippi'],
      ['MO', 'Missouri'],
      ['MT', 'Montana'],
      ['NE', 'Nebraska'],
      ['NV', 'Nevada'],
      ['NH', 'New Hampshire'],
      ['NJ', 'New Jersey'],
      ['NM', 'New Mexico'],
      ['NY', 'New York'],
      ['NC', 'North Carolina'],
      ['ND', 'North Dakota'],
      ['OH', 'Ohio'],
      ['OK', 'Oklahoma'],
      ['OR', 'Oregon'],
      ['PA', 'Pennsylvania'],
      ['PR', 'Puerto Rico'],
      ['RI', 'Rhode Island'],
      ['SC', 'South Carolina'],
      ['SD', 'South Dakota'],
      ['TN', 'Tennessee'],
      ['TX', 'Texas'],
      ['UT', 'Utah'],
      ['VT', 'Vermont'],
      ['VA', 'Virginia'],
      ['WA', 'Washington'],
      ['WV', 'West Virginia'],
      ['WI', 'Wisconsin'],
      ['WY', 'Wyoming'],
    ];

    select.appendChild(ui.el('option', { value: '' }, ['Select a state']));
    for (var i = 0; i < states.length; i++) {
      select.appendChild(ui.el('option', { value: states[i][0] }, [states[i][1]]));
    }

    var v = String(value || '')
      .trim()
      .toUpperCase();
    if (v) select.value = v;

    var wrap = ui.el('label', { class: 'sp-field' }, [
      ui.el('div', { class: 'sp-field__label' }, [label + (required ? ' *' : '')]),
      select,
    ]);

    return { wrap: wrap, input: select };
  }

  function openModal(ui, opts) {
    opts = opts || {};
    var onClose = typeof opts.onClose === 'function' ? opts.onClose : function () {};

    var overlay = ui.el('div', { class: 'sp-modal' }, []);
    var card = ui.el('div', { class: 'sp-modal__card' }, []);
    overlay.appendChild(card);

    var title = ui.el('div', { class: 'sp-modal__title' }, ['Change shipping address']);
    var body = ui.el('div', { class: 'sp-modal__body' }, []);
    var footer = ui.el('div', { class: 'sp-modal__footer' }, []);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(footer);

    function close() {
      try {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
      try {
        document.body.classList.remove('sp-modal-open');
      } catch (e) {}
      onClose();
    }

    overlay.addEventListener('click', function (e) {
      if (e && e.target === overlay) close();
    });

    try {
      document.body.classList.add('sp-modal-open');
    } catch (e) {}
    document.body.appendChild(overlay);

    return { overlay: overlay, card: card, body: body, footer: footer, close: close };
  }

  function field(ui, label, placeholder, value, required, autocomplete) {
    var attrs = {
      class: 'sp-input',
      type: 'text',
      placeholder: placeholder || '',
      value: value || '',
    };

    if (autocomplete) attrs.autocomplete = autocomplete;

    if (required) {
      attrs.required = true;
      attrs['aria-required'] = 'true';
    }

    var input = ui.el('input', attrs);

    var wrap = ui.el('label', { class: 'sp-field' }, [
      ui.el('div', { class: 'sp-field__label' }, [label + (required ? ' *' : '')]),
      input,
    ]);

    return { wrap: wrap, input: input };
  }

  function refreshCurrentScreen() {
    try {
      if (
        window.__SP &&
        window.__SP.screens &&
        window.__SP.screens.subscriptionDetail &&
        typeof window.__SP.screens.subscriptionDetail.render === 'function'
      ) {
        window.__SP.screens.subscriptionDetail.render();
        return;
      }
    } catch (e) {}

    try {
      if (
        window.__SP &&
        window.__SP.screens &&
        window.__SP.screens.subscriptions &&
        typeof window.__SP.screens.subscriptions.render === 'function'
      ) {
        window.__SP.screens.subscriptions.render();
        return;
      }
    } catch (e2) {}
  }

  // ---------------------------------------------------------------------------
  // Patch helper: write patch.address into contract.deliveryMethod.address
  // ---------------------------------------------------------------------------

  function applyAddressPatchToContract(contract, patchAddress) {
    var base = contract && typeof contract === 'object' ? contract : {};
    var next = shallowClone(base);

    var dm =
      next.deliveryMethod && typeof next.deliveryMethod === 'object'
        ? shallowClone(next.deliveryMethod)
        : {};

    dm.address = shallowClone(patchAddress || {});
    next.deliveryMethod = dm;

    try {
      next.updatedAt = new Date().toISOString();
    } catch (e) {}

    return next;
  }

  // ---------------------------------------------------------------------------
  // Action: Change Shipping Address
  // ---------------------------------------------------------------------------

  window.__SP.actions.changeShippingAddress = function changeShippingAddress(
    ui,
    contractGid,
    initial,
    defaults
  ) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');

    initial = initial || {};
    defaults = defaults || {};

    var modal = openModal(ui, {});
    var errBox = ui.el('div', { class: 'sp-alert sp-alert--error', style: 'display:none;' }, [
      ui.el('div', { class: 'sp-alert__title' }, ['Check your address']),
      ui.el('div', { class: 'sp-alert__body sp-muted' }, ['']),
    ]);
    modal.body.appendChild(errBox);

    var customer = getCustomerFromRoot();

    var fFirst = field(
      ui,
      'First name',
      'John',
      toStr(customer.firstName || ''),
      true,
      'given-name'
    );

    var fLast = field(ui, 'Last name', 'Doe', toStr(customer.lastName || ''), true, 'family-name');

    // Address fields intentionally NOT pre-populated
    var f1 = field(ui, 'Street address', '123 Main St', '', true, 'address-line1');

    var f2 = field(ui, 'Apt / Ste (optional)', 'Apt 4B', '', false, 'address-line2');

    var fCity = field(ui, 'City', 'Austin', '', true, 'address-level2');

    var fState = stateSelect(ui, 'State', '', true);
    try {
      fState.input.autocomplete = 'address-level1';
    } catch (e) {}

    var fZip = field(ui, 'Zip', '78701', '', true, 'postal-code');

    modal.body.appendChild(fFirst.wrap);
    modal.body.appendChild(fLast.wrap);
    modal.body.appendChild(f1.wrap);
    modal.body.appendChild(f2.wrap);
    modal.body.appendChild(fCity.wrap);
    modal.body.appendChild(fState.wrap);
    modal.body.appendChild(fZip.wrap);

    var btnCancel = ui.el('button', { type: 'button', class: 'sp-btn sp-btn--ghost' }, ['Cancel']);
    var btnSave = ui.el('button', { type: 'button', class: 'sp-btn' }, ['Save']);

    modal.footer.appendChild(btnSave);
    modal.footer.appendChild(btnCancel);

    btnCancel.addEventListener('click', modal.close);

    function showError(msg) {
      try {
        errBox.style.display = '';
        errBox.querySelector('.sp-alert__body').textContent =
          msg || 'Please check the fields and try again.';
      } catch (e) {}
    }

    btnSave.addEventListener('click', function () {
      var firstName = requiredTrim(fFirst.input.value);
      var lastName = requiredTrim(fLast.input.value);
      var address1 = requiredTrim(f1.input.value);
      var address2 = requiredTrim(f2.input.value);
      var city = requiredTrim(fCity.input.value);
      var provinceCode = requiredTrim(fState.input.value);
      var zip = requiredTrim(fZip.input.value);

      if (!firstName) return showError('First name is required.');
      if (!lastName) return showError('Last name is required.');
      if (!address1) return showError('Street address is required.');
      if (!city) return showError('City is required.');
      if (!provinceCode) return showError('State is required.');
      if (!zip) return showError('Zip is required.');

      return busy.withBusy(
        ui,
        async function () {
          try {
            var contractId = Number(shortId(contractGid));

            trackAction('change_shipping_address', { status: 'attempt' });

            var payload = {
              contractId: contractId,
              firstName: firstName,
              lastName: lastName,
              address1: address1,
              address2: address2,
              city: city,
              provinceCode: provinceCode,
              zip: zip,
              countryCode: defaults.countryCode || 'US',
              country: defaults.country || 'United States',
              methodType: defaults.methodType || 'SHIPPING',
            };

            var resp = await window.__SP.api.postJson('address', payload);

            if (!resp || resp.ok === false) {
              throw new Error(resp && resp.error ? resp.error : 'address_update_failed');
            }

            // Prefer resp.patch.address; fallback to resp.address; fallback to modal payload
            var patchAddress =
              resp.patch && resp.patch.address && typeof resp.patch.address === 'object'
                ? resp.patch.address
                : resp.address && typeof resp.address === 'object'
                  ? resp.address
                  : {
                      firstName: payload.firstName,
                      lastName: payload.lastName,
                      address1: payload.address1,
                      address2: payload.address2,
                      city: payload.city,
                      provinceCode: payload.provinceCode,
                      zip: payload.zip,
                      countryCode: payload.countryCode,
                      country: payload.country,
                    };

            // Patch contract in cache + refresh TTL
            var cached = getContractFromCacheByGid(contractGid);
            var base = cached || { id: String(contractGid) };
            var patched = applyAddressPatchToContract(base, patchAddress);

            var wrote = upsertContractIntoCache(patched);
            if (!wrote) {
              try {
                console.warn('[changeShippingAddress] failed to write cache', SUBS_CACHE_KEY);
              } catch (e) {}
            }

            // Optional "recent updated" marker (not required by detail UI yet)
            saveRecentAddress(contractGid, patchAddress);

            var nice = formatAddressLine(patchAddress);
            busy.showToast(ui, 'Shipping address updated: ' + nice, 'success');

            modal.close();
            refreshCurrentScreen();
            trackAction('change_shipping_address', { status: 'success' });
            trackActionResult('change_shipping_address', true);
            return { ok: true, contract: patched, patch: patchAddress };
          } catch (e) {
            showError('We couldn’t update that address. Please double-check it and try again.');
            try {
              busy.showToast(ui, 'Sorry — we couldn’t update that address.', 'error');
            } catch (_) {}
            trackAction('change_shipping_address', { status: 'error' });
            trackActionResult('change_shipping_address', false, {
              reason: toStr(e && e.message),
            });
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        'Updating your shipping address…'
      );
    });

    try {
      f1.input.focus();
    } catch (e) {}
  };
})();
