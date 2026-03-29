// screens/Home.jsx
import { useState, useEffect, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson } from '../core/api.js';
import { SkeletonCard } from '../components/Skeleton.jsx';

export default function Home() {
  const { config, router } = useContext(PortalContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    requestJson('home', {}, { force: true })
      .then(d => setData(d))
      .catch(() => setError(true));
  }, []);

  if (error) {
    return (
      <div class="sp-wrap sp-grid">
        <div class="sp-card">
          <div class="sp-error-title">We hit a snag</div>
          <div class="sp-error-text sp-muted">Please refresh, or contact support if this keeps happening.</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div class="sp-wrap sp-grid"><SkeletonCard /></div>;
  }

  const greeting = config.firstName
    ? 'Welcome back, ' + config.firstName
    : 'Welcome back';

  return (
    <div class="sp-wrap sp-grid sp-home">
      <div class="sp-card sp-home-card">
        <div class="sp-home-header">
          <div class="sp-home-header-left">
            <div class="sp-home-title">{greeting}</div>
            <div class="sp-home-subtitle sp-muted">{data.appName || 'Subscription Portal'}</div>
          </div>
        </div>
        <div class="sp-home-description sp-muted">
          Manage your upcoming orders, shipping details, and subscription status.
        </div>
        <div class="sp-home-actions">
          <a class="sp-btn sp-btn--primary" href={router.base + '/subscriptions?status=active'}
            onClick={(e) => { e.preventDefault(); router.navigate(router.base + '/subscriptions?status=active'); }}>
            View subscriptions
          </a>
        </div>
      </div>
    </div>
  );
}
