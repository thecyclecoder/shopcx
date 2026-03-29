// components/Pill.jsx — Status pills

const CLASSES = {
  active: 'sp-pill sp-pill--active',
  paused: 'sp-pill sp-pill--paused',
  cancelled: 'sp-pill sp-pill--cancelled',
  dunning: 'sp-pill sp-pill--dunning',
  neutral: 'sp-pill sp-pill--neutral',
};

export default function Pill({ kind, children }) {
  return <span class={CLASSES[kind] || CLASSES.neutral}>{children}</span>;
}
