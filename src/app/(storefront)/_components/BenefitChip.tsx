/**
 * Benefit card — bold, gradient-backed feature tile.
 *
 * Replaces the old low-contrast pill chips. Each benefit gets a vibrant
 * gradient + matching icon so the bar reads as "this is what the product
 * actually does for you" instead of fading into the page.
 *
 * Color is rotated by index (mod 4). Admin orders the benefits, so
 * picking the rotation here keeps the visual rhythm even if the copy
 * changes — no parsing benefit text or guessing semantic categories.
 */

const PALETTES = [
  {
    // Warm amber — energy / focus
    bg: "from-amber-50 to-orange-100",
    border: "border-amber-200/60",
    iconBg: "from-amber-400 to-orange-500",
    iconShadow: "shadow-orange-500/30",
  },
  {
    // Cool emerald — clean / healthy
    bg: "from-emerald-50 to-teal-100",
    border: "border-emerald-200/60",
    iconBg: "from-emerald-400 to-teal-500",
    iconShadow: "shadow-emerald-500/30",
  },
  {
    // Vibrant rose — heart / vitality
    bg: "from-rose-50 to-pink-100",
    border: "border-rose-200/60",
    iconBg: "from-rose-400 to-pink-500",
    iconShadow: "shadow-rose-500/30",
  },
  {
    // Cool indigo — mind / clarity
    bg: "from-indigo-50 to-violet-100",
    border: "border-indigo-200/60",
    iconBg: "from-indigo-400 to-violet-500",
    iconShadow: "shadow-indigo-500/30",
  },
] as const;

function ZapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function LeafIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

const ICONS = [ZapIcon, SparkleIcon, LeafIcon, HeartIcon] as const;

export function BenefitChip({ label, index = 0 }: { label: string; index?: number }) {
  const palette = PALETTES[index % PALETTES.length];
  const Icon = ICONS[index % ICONS.length];

  return (
    <div
      className={`group flex items-start gap-3 rounded-2xl border bg-gradient-to-br p-3.5 transition-transform duration-200 hover:scale-[1.02] ${palette.bg} ${palette.border}`}
    >
      <div
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ${palette.iconBg} ${palette.iconShadow}`}
      >
        <Icon />
      </div>
      <p className="pt-1 text-sm font-semibold leading-snug text-zinc-900 sm:text-[15px]">
        {label}
      </p>
    </div>
  );
}
