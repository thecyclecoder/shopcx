// components/Skeleton.jsx — Shimmer skeleton loaders

export function SkeletonLine({ width }) {
  return <div class="sp-skeleton-line" style={width ? { width } : undefined} />;
}

export function SkeletonLines({ count = 3, widths = [] }) {
  return (
    <div class="sp-skeleton-lines">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonLine key={i} width={widths[i]} />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div class="sp-card sp-skeleton-card">
      <SkeletonLine width="40%" />
      <div class="sp-skeleton-spacer" />
      <SkeletonLines count={3} widths={['100%', '100%', '60%']} />
    </div>
  );
}

export function SkeletonSubCard() {
  return (
    <div class="sp-card sp-subcard sp-skeleton-card">
      <div class="sp-skeleton-row">
        <SkeletonLines count={2} widths={['50%', '30%']} />
        <SkeletonLine width="60px" />
      </div>
      <div class="sp-skeleton-spacer" />
      {[1, 2].map(i => (
        <div key={i} class="sp-skeleton-line-item">
          <div class="sp-skeleton-thumb" />
          <SkeletonLines count={2} widths={['70%', '40%']} />
        </div>
      ))}
      <div class="sp-skeleton-spacer" />
      <SkeletonLine width="120px" />
    </div>
  );
}

export function SkeletonCancelScreen() {
  return (
    <div class="sp-card sp-skeleton-card">
      <SkeletonLine width="30%" />
      <div class="sp-skeleton-spacer" />
      <SkeletonLine width="60%" />
      <SkeletonLine width="40%" />
      <div class="sp-skeleton-spacer" />
      <div class="sp-skeleton-reason-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} class="sp-skeleton-tile"><SkeletonLine width="80%" /></div>
        ))}
      </div>
    </div>
  );
}
