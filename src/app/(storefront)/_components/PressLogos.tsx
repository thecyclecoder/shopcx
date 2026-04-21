import Image from "next/image";
import { bestMediaUrl, type MediaItem } from "../_lib/page-data";

export function PressLogos({ media }: { media: Record<string, MediaItem> }) {
  const slots = ["press_1", "press_2", "press_3", "press_4", "press_5"];
  const logos = slots
    .map((slot) => media[slot])
    .filter((m): m is MediaItem => !!m && !!m.url);

  if (logos.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 opacity-60 grayscale">
      {logos.map((logo) => {
        const url = bestMediaUrl(logo);
        if (!url) return null;
        return (
          <Image
            key={logo.slot}
            src={url}
            alt={logo.alt_text || "Press"}
            width={96}
            height={28}
            loading="lazy"
            className="h-7 w-auto object-contain"
          />
        );
      })}
    </div>
  );
}
