import React from "react";
import { Composition } from "remotion";
import { AdComposition } from "./AdComposition";
import { AdStatic } from "./AdStatic";
import { ExampleAd, type ExampleAdProps } from "./ExampleAd";
import { StaticReview, StaticOffer, StaticBenefitAuthority, type StaticReviewProps, type StaticOfferProps, type StaticBenefitAuthorityProps } from "./StaticAds";
import { DEFAULT_PROPS, type AdCompositionProps } from "./types";

// Static-ad design defaults (4:5 feed). Brand mirrors src/lib/ad-static DEFAULT_BRAND.
const SBRAND = { bg: "#FBF7F0", fg: "#2B1A12", accent: "#E0561F", accentFg: "#FFFFFF", muted: "#8A7A6E" };
const SREVIEW: StaticReviewProps = { width: 1080, height: 1350, brand: SBRAND, reviewerName: "Tamara L.", rating: 5, headline: "I have managed to lose roughly 50 pounds on my weight loss journey.", body: "I have been using this for almost two years. It took a bit for my body to adjust and start to feel healthier and help me with my weight loss journey. It's about not expecting immediate results — it's about the journey.", verified: true, productTitle: "Amazing Coffee", productImageUrl: null, fontKey: "montserrat" };
const SOFFER: StaticOfferProps = { width: 1080, height: 1350, brand: SBRAND, discount: "40% OFF", subline: "+ FREE SHIPPING", urgency: "For a limited time", ctaText: "Shop now", productTitle: "Amazing Coffee", productImageUrl: null, backdropUrl: null };
const SBENEFIT: StaticBenefitAuthorityProps = { width: 1080, height: 1350, brand: SBRAND, mode: "authority", productTitle: "Amazing Coffee", productImageUrl: null, benefits: ["12 superfoods in one cup", "Clean energy, no crash", "Curbs cravings"], expert: { name: "Lindsey Ray", title: "Registered Dietitian, MS, RD, LD", quote: "This coffee checks all the boxes — rich in antioxidants, supports weight loss, and the taste is delicious.", bullets: ["Antioxidant rich", "Supports weight loss", "Delicious taste"] } };

const EXAMPLE_DEFAULT: ExampleAdProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 20,
  segments: [],
  broll: [],
  music: null,
  captions: [],
};

/**
 * Two compositions: AdComposition (video MP4) and AdStatic (still JPG). The
 * renderer in ad-render.ts selects one by id and passes inputProps. width/height/
 * fps/durationInFrames are calculated per-render from the inputProps.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AdComposition"
        component={AdComposition as React.FC<Record<string, unknown>>}
        durationInFrames={DEFAULT_PROPS.durationSec * DEFAULT_PROPS.fps}
        fps={DEFAULT_PROPS.fps}
        width={DEFAULT_PROPS.width}
        height={DEFAULT_PROPS.height}
        defaultProps={DEFAULT_PROPS as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as AdCompositionProps;
          return { durationInFrames: Math.round(p.durationSec * p.fps), fps: p.fps, width: p.width, height: p.height };
        }}
      />
      <Composition
        id="AdStatic"
        component={AdStatic as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={DEFAULT_PROPS.width}
        height={DEFAULT_PROPS.height}
        defaultProps={{ ...DEFAULT_PROPS, mediaKind: "static" } as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as AdCompositionProps;
          return { durationInFrames: 1, fps: 1, width: p.width, height: p.height };
        }}
      />
      <Composition
        id="ExampleAd"
        component={ExampleAd as React.FC<Record<string, unknown>>}
        durationInFrames={EXAMPLE_DEFAULT.durationSec * EXAMPLE_DEFAULT.fps}
        fps={EXAMPLE_DEFAULT.fps}
        width={EXAMPLE_DEFAULT.width}
        height={EXAMPLE_DEFAULT.height}
        defaultProps={EXAMPLE_DEFAULT as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as ExampleAdProps;
          return { durationInFrames: Math.round(p.durationSec * p.fps), fps: p.fps, width: p.width, height: p.height };
        }}
      />
      {/* Static-ad archetypes — single-frame designed stills (1:1 / 4:5 / 9:16). */}
      <Composition
        id="StaticReview"
        component={StaticReview as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={SREVIEW.width}
        height={SREVIEW.height}
        defaultProps={SREVIEW as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => { const p = props as unknown as StaticReviewProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }}
      />
      <Composition
        id="StaticOffer"
        component={StaticOffer as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={SOFFER.width}
        height={SOFFER.height}
        defaultProps={SOFFER as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => { const p = props as unknown as StaticOfferProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }}
      />
      <Composition
        id="StaticBenefitAuthority"
        component={StaticBenefitAuthority as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={SBENEFIT.width}
        height={SBENEFIT.height}
        defaultProps={SBENEFIT as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => { const p = props as unknown as StaticBenefitAuthorityProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }}
      />
    </>
  );
};
