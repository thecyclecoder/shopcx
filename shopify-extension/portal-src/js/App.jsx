// App.jsx — Main app shell with router
import { createContext } from 'preact';
import { useRouter } from './hooks/useRouter.js';
import { useToast } from './hooks/useToast.js';
import Home from './screens/Home.jsx';
import Subscriptions from './screens/Subscriptions.jsx';
import SubscriptionDetail from './screens/SubscriptionDetail.jsx';
import Cancel from './screens/Cancel.jsx';

export const PortalContext = createContext(null);

export default function App({ config }) {
  const router = useRouter(config.portalPage);
  const { toast, showToast, hideToast } = useToast();

  const ctx = { config, router, showToast };

  let screen;
  switch (router.screen) {
    case 'subscriptions': screen = <Subscriptions />; break;
    case 'detail':        screen = <SubscriptionDetail />; break;
    case 'cancel':        screen = <Cancel />; break;
    default:              screen = <Home />;
  }

  return (
    <PortalContext.Provider value={ctx}>
      {screen}
      {toast && (
        <div class={`sp-toast sp-toast--${toast.type}`} onClick={hideToast}>
          <div class="sp-toast__body">{toast.message}</div>
        </div>
      )}
    </PortalContext.Provider>
  );
}
