/**
 * Director SVG mascots (agents-hub-role-inboxes spec, Phase 2).
 *
 * Inline SVG components — one per persona — so the Agents hub (and M3's gamified
 * #directors board) can render a character avatar with NO asset pipeline. Each is a
 * friendly rounded face with a role-hinting accessory; colors inherit from the
 * persona via `currentColor` (the persona's text color is applied by the chip), so
 * a reskin in personas.ts flows straight through. Keyed by `MascotId`.
 *
 * See src/lib/agents/personas.ts + docs/brain/libraries/agent-personas.md.
 */
import type { MascotId } from "@/lib/agents/personas";

interface MascotProps {
  className?: string;
  size?: number;
  title?: string;
}

// Shared friendly face — eyes + smile — so the cast reads as a team.
function Face() {
  return (
    <>
      <circle cx="9.5" cy="13" r="1.05" fill="currentColor" />
      <circle cx="14.5" cy="13" r="1.05" fill="currentColor" />
      <path d="M9.5 16c.8.8 1.6 1.1 2.5 1.1s1.7-.3 2.5-1.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  );
}

function Frame({ children, className, size = 40, title }: MascotProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* head */}
      <circle cx="12" cy="13" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {children}
    </svg>
  );
}

// 🛠️ Ada — Platform. Hard hat / wrench antenna.
function AdaMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M5.6 8.5c1.3-2.2 3.7-3.6 6.4-3.6s5.1 1.4 6.4 3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 4.8V2.6M12 2.6l1.6 1M12 2.6l-1.6 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <Face />
    </Frame>
  );
}

// 🚀 Max — Growth. Rocket fin ears + upward spark.
function MaxMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M4.4 12.5l-1.5 1.8 2.3-.2M19.6 12.5l1.5 1.8-2.3-.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5V2.4M10.7 3.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <Face />
    </Frame>
  );
}

// 🎨 Iris — CMO. Paint-palette dots.
function IrisMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <circle cx="7" cy="9.5" r="0.8" fill="currentColor" />
      <circle cx="17" cy="9.5" r="0.8" fill="currentColor" />
      <circle cx="9" cy="6.6" r="0.8" fill="currentColor" />
      <circle cx="15" cy="6.6" r="0.8" fill="currentColor" />
      <Face />
    </Frame>
  );
}

// 💬 June — CS. Speech-bubble tail.
function JuneMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M7.5 19.5c-.4 1.2-1.4 2-1.4 2s2-.2 3-1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 6.5c.6-.7 1.6-1 2.6-.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <Face />
    </Frame>
  );
}

// 🧲 Theo — Retention. Magnet horns.
function TheoMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M8 6.2c-.9-1-1.1-2.4-.6-3.6M16 6.2c.9-1 1.1-2.4.6-3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6.6 3.2l1.4.4M17.4 3.2l-1.4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <Face />
    </Frame>
  );
}

// 👑 CEO — crown.
function CeoMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M6.5 7.5l-.9-3 2.6 1.8L12 3l1.8 3.3 2.6-1.8-.9 3z" fill="currentColor" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round" />
      <Face />
    </Frame>
  );
}

// Neutral fallback for a director with no persona yet.
function DefaultMascot(p: MascotProps) {
  return (
    <Frame {...p}>
      <path d="M12 4.9V3M8.8 4.6l-.6-.9M15.2 4.6l.6-.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <Face />
    </Frame>
  );
}

const MASCOTS: Record<MascotId, (p: MascotProps) => React.ReactNode> = {
  ada: AdaMascot,
  max: MaxMascot,
  iris: IrisMascot,
  june: JuneMascot,
  theo: TheoMascot,
  ceo: CeoMascot,
  default: DefaultMascot,
};

/** Render a mascot by id. Color inherits from `currentColor` (set the text color on a wrapper). */
export function Mascot({ id, className, size, title }: { id: MascotId } & MascotProps) {
  const Cmp = MASCOTS[id] ?? DefaultMascot;
  return <Cmp className={className} size={size} title={title} />;
}
