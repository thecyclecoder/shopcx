"use client";

/**
 * Trimmed StorefrontPixelInit for the blog. Calls initPixel — which
 * creates the storefront_sessions row + fires the Meta base PageView
 * when metaPixelId is set — then fires `blog_view` on mount and a
 * single `blog_engaged` on first of scroll-50% / 30s dwell.
 *
 * Deliberately excludes pdp_view, pack_selected, add_to_cart: blog
 * pages aren't PDPs and firing those would pollute product funnels.
 */

import { useEffect } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";

interface Props {
  workspaceId: string;
  metaPixelId?: string | null;
  blogHandle?: string | null;
  title?: string | null;
}

export function BlogPixelInit({ workspaceId, metaPixelId, blogHandle, title }: Props) {
  useEffect(() => {
    initPixel({ workspaceId, customerId: null, metaPixelId: metaPixelId || null });

    track("blog_view", {
      blog_handle: blogHandle || null,
      title: title || null,
    });

    let engaged = false;
    const fireEngaged = (trigger: string) => {
      if (engaged) return;
      engaged = true;
      track("blog_engaged", {
        trigger,
        blog_handle: blogHandle || null,
      });
      cleanup();
    };

    const onScroll = () => {
      const scrollY = window.scrollY;
      const viewportH = window.innerHeight;
      const docH = document.documentElement.scrollHeight;
      if (docH > viewportH && (scrollY + viewportH) / docH >= 0.5) {
        fireEngaged("scroll_50");
      }
    };

    const dwellTimer = window.setTimeout(() => fireEngaged("dwell_30s"), 30_000);
    window.addEventListener("scroll", onScroll, { passive: true });

    function cleanup() {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(dwellTimer);
    }

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, blogHandle]);

  return null;
}
