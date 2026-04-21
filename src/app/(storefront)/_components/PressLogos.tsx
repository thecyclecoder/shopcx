import type { MediaItem } from "../_lib/page-data";
import { Picture } from "./PictureHero";

export function PressLogos({ media }: { media: Record<string, MediaItem> }) {
  const slots = ["press_1", "press_2", "press_3", "press_4", "press_5"];
  const logos = slots
    .map((slot) => media[slot])
    .filter((m): m is MediaItem => !!m && !!m.url);

  if (logos.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 opacity-60 grayscale [&_img]:h-7 [&_img]:w-auto [&_img]:object-contain">
      {logos.map((logo) => (
        // width/height match the displayed size exactly. Any mismatch
        // here causes a visible layout shift: the browser reserves
        // space from these intrinsics during HTML parse, then CSS
        // resizes via h-7 w-auto once the stylesheet arrives.
        <Picture
          key={logo.slot}
          media={logo}
          altFallback="Press"
          sizes="96px"
          width={96}
          height={28}
          className="h-7 w-auto object-contain"
        />
      ))}
    </div>
  );
}
