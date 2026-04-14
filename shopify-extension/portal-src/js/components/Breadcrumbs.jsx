// components/Breadcrumbs.jsx — Portal breadcrumb navigation
export default function Breadcrumbs({ items }) {
  if (!items || items.length === 0) return null;

  return (
    <div class="sp-bc__wrap">
      <nav class="sp-bc" aria-label="Breadcrumb">
        {items.map((item, i) => (
          <span key={i}>
            {i > 0 && <span class="sp-bc__sep">{'\u2192'}</span>}
            {item.icon ? (
              item.onClick ? (
                <a href="#" class="sp-bc__icon-link" onClick={(e) => { e.preventDefault(); item.onClick(); }}>
                  <span class="sp-bc__icon">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </span>
                </a>
              ) : (
                <span class="sp-bc__icon">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </span>
              )
            ) : item.onClick && i < items.length - 1 ? (
              <a href="#" class="sp-bc__a" onClick={(e) => { e.preventDefault(); item.onClick(); }}>
                {item.label}
              </a>
            ) : i === items.length - 1 ? (
              <span class="sp-bc__cur">{item.label}</span>
            ) : (
              <span class="sp-bc__disabled">{item.label}</span>
            )}
          </span>
        ))}
      </nav>
    </div>
  );
}
