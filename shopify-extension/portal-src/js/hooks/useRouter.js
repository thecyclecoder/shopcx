// hooks/useRouter.js — SPA routing hook
import { useState, useEffect, useCallback } from 'preact/hooks';

export function useRouter(portalBase) {
  const base = (portalBase || '/pages/portal').replace(/\/+$/, '');

  const resolve = useCallback(() => {
    const path = window.location.pathname.replace(/\/+$/, '');
    const params = new URLSearchParams(window.location.search);

    if (path === base) return { screen: 'home', params };
    if (path.startsWith(base + '/subscriptions')) return { screen: 'subscriptions', params };
    if (path === base + '/subscription') {
      const intent = (params.get('intent') || '').toLowerCase();
      if (intent === 'cancel') return { screen: 'cancel', params };
      return { screen: 'detail', params };
    }
    return { screen: 'home', params };
  }, [base]);

  const [route, setRoute] = useState(resolve);

  useEffect(() => {
    const onNav = () => setRoute(resolve());
    window.addEventListener('popstate', onNav);
    window.addEventListener('sp:locationchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('sp:locationchange', onNav);
    };
  }, [resolve]);

  const navigate = useCallback((href) => {
    try { window.history.pushState({}, '', href); } catch { window.location.href = href; return; }
    setRoute(resolve());
  }, [resolve]);

  return { ...route, navigate, base };
}
