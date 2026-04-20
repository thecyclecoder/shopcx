export function BenefitChip({ label }: { label: string }) {
  return (
    <span className="inline-flex min-h-[36px] items-center rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800">
      {label}
    </span>
  );
}
