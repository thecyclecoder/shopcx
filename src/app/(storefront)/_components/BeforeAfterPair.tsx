import type { MediaItem } from "../_lib/page-data";
import { Picture } from "./PictureHero";

/**
 * Static before/after pair — two images side-by-side, full visible,
 * with corner badges. Used in UGCSection above the featured reviews.
 *
 * Renders nothing when either image is missing.
 */
export function BeforeAfterPair({
  before,
  after,
  altPrefix = "Customer transformation",
}: {
  before: MediaItem | null;
  after: MediaItem | null;
  altPrefix?: string;
}) {
  if (!before || !after) return null;

  // Match aspect ratios to whichever image is tallest so both fit
  // inside the same row without one cropping the other.
  const aw = before.width || 4;
  const ah = before.height || 5;
  const bw = after.width || 4;
  const bh = after.height || 5;
  // Use the more vertical aspect to keep both fully visible side-by-side.
  const sourceAspect = ah / aw > bh / bw ? { w: aw, h: ah } : { w: bw, h: bh };

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      <BeforeAfterTile media={before} label="BEFORE" altPrefix={altPrefix} aspect={sourceAspect} />
      <BeforeAfterTile media={after} label="AFTER" altPrefix={altPrefix} aspect={sourceAspect} />
    </div>
  );
}

function BeforeAfterTile({
  media,
  label,
  altPrefix,
  aspect,
}: {
  media: MediaItem;
  label: "BEFORE" | "AFTER";
  altPrefix: string;
  aspect: { w: number; h: number };
}) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-zinc-100 shadow-sm"
      style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
    >
      <div className="[&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
        <Picture
          media={media}
          altFallback={`${altPrefix} — ${label.toLowerCase()}`}
          sizes="(min-width: 768px) 28vw, 50vw"
          width={aspect.w}
          height={aspect.h}
        />
      </div>
      <span className="absolute left-2 top-2 inline-flex items-center rounded-md bg-black/65 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white backdrop-blur sm:left-3 sm:top-3 sm:px-2.5 sm:py-1 sm:text-xs">
        {label}
      </span>
    </div>
  );
}
