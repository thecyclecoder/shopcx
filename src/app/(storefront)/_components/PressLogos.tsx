import type { MediaItem } from "../_lib/page-data";
import { Picture } from "./PictureHero";

export function PressLogos({
  media,
  label,
  align = "center",
}: {
  media: Record<string, MediaItem>;
  /** Optional eyebrow, e.g. "As Seen On". Renders above the logo row. */
  label?: string;
  align?: "start" | "center";
}) {
  const slots = ["press_1", "press_2", "press_3", "press_4", "press_5"];
  const logos = slots
    .map((slot) => media[slot])
    .filter((m): m is MediaItem => !!m && !!m.url);

  if (logos.length === 0) return null;

  const alignClass = align === "center" ? "items-center text-center" : "items-start text-left";
  const rowJustify = align === "center" ? "justify-center" : "justify-start";

  return (
    // Logos are typically supplied pre-tinted to the brand color, so we
    // do NOT grayscale them (that would wash out the tint). A light
    // opacity keeps the row from competing with the headline.
    <div className={`flex flex-col gap-2.5 ${alignClass}`}>
      {label && (
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
          {label}
        </span>
      )}
      <div
        className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${rowJustify} opacity-90 [&_img]:h-7 [&_img]:w-auto [&_img]:object-contain sm:[&_img]:h-8`}
      >
        {logos.map((logo) => (
          // width/height match the displayed size exactly. Any mismatch
          // here causes a visible layout shift: the browser reserves
          // space from these intrinsics during HTML parse, then CSS
          // resizes via h-7 w-auto once the stylesheet arrives.
          <Picture
            key={logo.slot}
            media={logo}
            altFallback="As seen on"
            sizes="112px"
            width={112}
            height={32}
            className="h-7 w-auto object-contain sm:h-8"
          />
        ))}
      </div>
    </div>
  );
}
