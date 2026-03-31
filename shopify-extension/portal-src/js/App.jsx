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
import Breadcrumbs from './components/Breadcrumbs.jsx';

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

  // Breadcrumbs per screen
  const goHome = () => router.navigate(router.base);
  const goSubs = () => router.navigate(router.base + '/subscriptions');
  let breadcrumbs = [];
  let screen;

  if (config.banned) {
    breadcrumbs = [{ label: 'Manager' }, { label: 'Restricted' }];
    screen = <BannedView />;
  } else {
    switch (router.screen) {
      case 'subscriptions':
        breadcrumbs = [{ label: 'Manager', onClick: goHome }, { label: 'Subscriptions' }];
        screen = <Subscriptions />;
        break;
      case 'detail':
        breadcrumbs = [{ label: 'Manager', onClick: goHome }, { label: 'Subscriptions', onClick: goSubs }, { label: 'View' }];
        screen = <SubscriptionDetail />;
        break;
      case 'cancel':
        breadcrumbs = [{ label: 'Manager', onClick: goHome }, { label: 'Subscriptions', onClick: goSubs }, { label: 'Cancel' }];
        screen = <Cancel />;
        break;
      default:
        breadcrumbs = [{ label: 'Manager', onClick: goHome }, { label: 'Home' }];
        screen = <Home />;
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
      <Breadcrumbs items={breadcrumbs} />
      {screen}
      {toastEl && createPortal(toastEl, document.body)}
    </PortalContext.Provider>
  );
}
