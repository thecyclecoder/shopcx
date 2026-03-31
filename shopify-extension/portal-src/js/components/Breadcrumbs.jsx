// components/Breadcrumbs.jsx — Portal breadcrumb navigation
export default function Breadcrumbs({ items }) {
  if (!items || items.length === 0) return null;

  return (
    <div class="sp-bc__wrap">
      <nav class="sp-bc" aria-label="Breadcrumb">
        <span class="sp-bc__icon">
          <svg class="sp-bc__icon-svg" viewBox="0 0 24 24" fill="none">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
        {items.map((item, i) => (
          <span key={i}>
            {i > 0 && <span class="sp-bc__sep">&rarr;</span>}
            {item.onClick && i < items.length - 1 ? (
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
