// src/portal-entry.js
// Bundler entrypoint: imports must run in-order so globals are registered.

import './core/utils.js';
import './core/ui.js';
import './core/api.js';
// Analytics (registered onto window.__SP.analytics)
import './assets/analytics.js';
// Cards (registered onto window.__SP.cards)
import './cards/shipping-protection.js';
import './cards/pause.js';
import './cards/resume.js';
import './cards/address.js';
import './cards/coupon.js';
import './cards/rewards.js';
import './cards/frequency.js';
import './cards/items.js';
import './cards/addons.js';
import './cards/cancel.js';
import './cards/reviews.js';

// Modals (registered onto window.__SP.modals)
import './modals/add-swap.js';
import './modals/remove.js';
import './modals/quantity.js';
import './modals/review.js';

// Actions (registered onto window.__SP.actions)
import './actions/busy.js';
import './actions/pause.js';
import './actions/resume.js';
import './actions/change-shipping-address.js';
import './actions/toggle-shipping-protection.js';
import './actions/coupon.js';
import './actions/frequency.js';
import './actions/add-swap.js';
import './actions/remove.js';
import './actions/quantity.js';
import './actions/cancel.js';

// Data (registered onto window.__SP.data)
import './data/reviews.js';

// Screens (registered onto window.__SP.screens)
import './screens/home.js';
import './screens/subscriptions.js';
import './screens/subscription-detail.js';
import './screens/cancel.js';
import './screens/router.js';
