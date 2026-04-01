// Lightweight confetti animation — pure JS, no dependencies
// Spawns colored particles that fall and fade out

const COLORS = ['#22c55e', '#14b8a6', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899'];
const PARTICLE_COUNT = 60;
const DURATION = 3000;

let styleInjected = false;
function ensureKeyframes() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes sp-confetti-fall {
      0% { transform: translateY(0) translateX(0) rotate(0deg); opacity: 1; }
      75% { opacity: 1; }
      100% { transform: translateY(100vh) translateX(var(--sp-drift,0px)) rotate(var(--sp-rot,360deg)); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
  styleInjected = true;
}

export function fireConfetti() {
  ensureKeyframes();
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const el = document.createElement('div');
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const x = Math.random() * 100;
    const delay = Math.random() * 600;
    const size = 6 + Math.random() * 6;
    const drift = (Math.random() - 0.5) * 120;
    const rotEnd = Math.random() * 720 - 360;
    const shape = Math.random() > 0.5 ? '50%' : '2px';

    el.style.cssText = `
      position:absolute;
      top:-12px;
      left:${x}%;
      width:${size}px;
      height:${size * (Math.random() > 0.5 ? 1.6 : 1)}px;
      background:${color};
      border-radius:${shape};
      opacity:1;
      animation:sp-confetti-fall ${1.8 + Math.random() * 1.2}s ease-out ${delay}ms forwards;
      --sp-drift:${drift}px;
      --sp-rot:${rotEnd}deg;
    `;
    container.appendChild(el);
  }

  setTimeout(() => container.remove(), DURATION + 800);
}
