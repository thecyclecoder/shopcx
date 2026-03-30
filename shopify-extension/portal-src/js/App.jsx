// App.jsx — Main app shell with router
import { createContext } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useRouter } from './hooks/useRouter.js';
import { useToast } from './hooks/useToast.js';
import Home from './screens/Home.jsx';
import Subscriptions from './screens/Subscriptions.jsx';
import SubscriptionDetail from './screens/SubscriptionDetail.jsx';
import Cancel from './screens/Cancel.jsx';
import BannedView from './screens/BannedView.jsx';

export const PortalContext = createContext(null);

export default function App({ config }) {
  const router = useRouter(config.portalPage);
  const { toast, showToast, hideToast } = useToast();
  const prevScreen = useRef(router.screen);

  // Scroll to top on screen change
  useEffect(() => {
    if (prevScreen.current !== router.screen) {
      window.scrollTo(0, 0);
      prevScreen.current = router.screen;
    }
  }, [router.screen]);

  const ctx = { config, router, showToast };

  // Banned customers see restricted view only
  let screen;
  if (config.banned) {
    screen = <BannedView />;
  } else {
    switch (router.screen) {
      case 'subscriptions': screen = <Subscriptions />; break;
      case 'detail':        screen = <SubscriptionDetail />; break;
      case 'cancel':        screen = <Cancel />; break;
      default:              screen = <Home />;
    }
  }

  // Toast portaled to document.body to escape host stacking contexts
  const toastEl = toast ? (
    <div class={`sp-toast sp-toast--${toast.type}`} onClick={hideToast}>
      <div class="sp-toast__body">{toast.message}</div>
    </div>
  ) : null;

  return (
    <PortalContext.Provider value={ctx}>
      {screen}
      {toastEl && createPortal(toastEl, document.body)}
    </PortalContext.Provider>
  );
}
