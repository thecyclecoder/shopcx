import React from "react";
import { Composition } from "remotion";
import { AdComposition } from "./AdComposition";
import { AdStatic } from "./AdStatic";
import { ExampleAd, type ExampleAdProps } from "./ExampleAd";
import { StaticReview, StaticOffer, StaticBenefitAuthority, type StaticReviewProps, type StaticOfferProps, type StaticBenefitAuthorityProps } from "./StaticAds";
import { StaticAdvertorial, type StaticAdvertorialProps } from "./StaticAdvertorial";
import { StaticTestimonial, StaticAuthority, StaticBigClaim, StaticBeforeAfter, type StaticTestimonialProps, type StaticAuthorityProps, type StaticBigClaimProps, type StaticBeforeAfterProps } from "./StaticArchetypes";
import { StaticIngredientBreakdown, type StaticIngredientBreakdownProps } from "./StaticIngredientBreakdown";
import { DEFAULT_PROPS, type AdCompositionProps } from "./types";

// Static-ad design defaults (4:5 feed). Brand mirrors src/lib/ad-static DEFAULT_BRAND.
const SBRAND = { bg: "#FBF7F0", fg: "#2B1A12", accent: "#E0561F", accentFg: "#FFFFFF", muted: "#8A7A6E" };
const SREVIEW: StaticReviewProps = { width: 1080, height: 1350, brand: SBRAND, reviewerName: "Tamara L.", rating: 5, headline: "I have managed to lose roughly 50 pounds on my weight loss journey.", body: "I have been using this for almost two years. It took a bit for my body to adjust and start to feel healthier and help me with my weight loss journey. It's about not expecting immediate results — it's about the journey.", verified: true, productTitle: "Amazing Coffee", productImageUrl: null, fontKey: "montserrat" };
const SOFFER: StaticOfferProps = { width: 1080, height: 1350, brand: SBRAND, discount: "40% OFF", subline: "+ FREE SHIPPING", urgency: "For a limited time", ctaText: "Shop now", productTitle: "Amazing Coffee", productImageUrl: null, backdropUrl: null };
const SBENEFIT: StaticBenefitAuthorityProps = { width: 1080, height: 1350, brand: SBRAND, mode: "authority", productTitle: "Amazing Coffee", productImageUrl: null, benefits: ["12 superfoods in one cup", "Supports healthy weight loss", "Antioxidants that fight aging"], expert: { name: "Lindsey Ray", title: "Registered Dietitian, MS, RD, LD", quote: "This coffee checks all the boxes — rich in antioxidants, supports weight loss, and the taste is delicious.", bullets: ["Antioxidant rich", "Supports weight loss", "Delicious taste"] } };

const SADVERTORIAL: StaticAdvertorialProps = {
  width: 1080, height: 1350,
  publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED", category: "HEALTH",
  byline: "By the Editorial Team", dateLabel: "June 2026",
  headline: "The Morning Coffee Doctors Wish More People Over 50 Knew About",
  dek: "It looks like regular coffee. But 12 clinically studied superfoods are doing the quiet work behind the scenes.",
  heroImageUrl: null, heroCaption: "Amazing Coffee — 12 superfoods in one cup.",
  body: [
    "Most people over 50 reach for coffee out of habit. A growing number are swapping it for one built around 12 clinically studied superfoods for healthy weight and younger-looking skin.",
    "Chaga, Turmeric and Green Coffee are studied for metabolism, antioxidants and skin — so the coffee you already love quietly works with you, not against you.",
  ],
  rating: 5, reviewCount: "12,291",
  badges: ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"],
  guarantee: "Backed by a 30-day money-back guarantee.",
  cta: "Read more →", accent: "#B0451C",
};

const STESTIMONIAL: StaticTestimonialProps = { width: 1080, height: 1350, brandBg: "#FBF8F2", accent: "#B0451C", quote: "I've lost 32 pounds in 9 weeks.", body: "I started drinking Amazing Coffee 9 weeks ago. Along with a healthy diet, the results have been amazing.", reviewerName: "Kristen N.", verified: true, faceImageUrl: null, productImageUrl: null, productTitle: "Amazing Coffee", reviewCount: "2,291", badges: ["Non-GMO", "3rd-Party Tested"], cta: "Shop now →" };
const SAUTHORITY: StaticAuthorityProps = { width: 1080, height: 1350, brandBg: "#FBF8F2", accent: "#B0451C", expertName: "Lindsey Ray", expertTitle: "Registered Dietitian, MS, RD", quote: "This coffee checks all the boxes — antioxidant rich, supports weight loss, and it tastes delicious.", bullets: ["Supports healthy weight loss", "Antioxidants that fight aging", "Improves skin elasticity"], faceImageUrl: null, productImageUrl: null, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested", "Made in USA"], cta: "Learn more →" };
const SBIGCLAIM: StaticBigClaimProps = { width: 1080, height: 1350, accent: "#B0451C", eyebrow: "After 50, read this", hook: "Your coffee is aging you.", emphasis: "aging you", reveal: "This one is built to fight back — 12 superfoods studied for antioxidants, weight and younger-looking skin.", productImageUrl: null, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested", "Sugar Free"], cta: "Shop now →" };
const SBEFOREAFTER: StaticBeforeAfterProps = { width: 1080, height: 1350, accent: "#B0451C", headline: "The transformation people are talking about", beforeLabel: "Before", afterLabel: "After", beforeText: "Where she started.", afterText: "Lighter, glowing — and getting compliments.", beforeImageUrl: null, afterImageUrl: null, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested"], cta: "Shop now →" };
const SBREAKDOWN: StaticIngredientBreakdownProps = {
  width: 1080, height: 1350,
  headline: "THE LONGER YOU DRINK IT, THE MORE IT WORKS.",
  heroImageUrl: null, productLabel: "12 Superfoods",
  ingredients: [
    { name: "Green Coffee", benefit: "Burns Fat", icon: "flame" },
    { name: "Matcha", benefit: "Metabolism", icon: "bolt" },
    { name: "Chaga", benefit: "Fights Aging", icon: "shield" },
    { name: "Turmeric", benefit: "Radiant Skin", icon: "sun" },
    { name: "Cordyceps", benefit: "Clean Energy", icon: "leaf" },
    { name: "Maca Root", benefit: "Drive", icon: "heart" },
  ],
};

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
      <Composition
        id="StaticAdvertorial"
        component={StaticAdvertorial as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={SADVERTORIAL.width}
        height={SADVERTORIAL.height}
        defaultProps={SADVERTORIAL as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => { const p = props as unknown as StaticAdvertorialProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }}
      />
      <Composition id="StaticTestimonial" component={StaticTestimonial as React.FC<Record<string, unknown>>} durationInFrames={1} fps={1} width={STESTIMONIAL.width} height={STESTIMONIAL.height} defaultProps={STESTIMONIAL as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as StaticTestimonialProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }} />
      <Composition id="StaticAuthority" component={StaticAuthority as React.FC<Record<string, unknown>>} durationInFrames={1} fps={1} width={SAUTHORITY.width} height={SAUTHORITY.height} defaultProps={SAUTHORITY as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as StaticAuthorityProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }} />
      <Composition id="StaticBigClaim" component={StaticBigClaim as React.FC<Record<string, unknown>>} durationInFrames={1} fps={1} width={SBIGCLAIM.width} height={SBIGCLAIM.height} defaultProps={SBIGCLAIM as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as StaticBigClaimProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }} />
      <Composition id="StaticBeforeAfter" component={StaticBeforeAfter as React.FC<Record<string, unknown>>} durationInFrames={1} fps={1} width={SBEFOREAFTER.width} height={SBEFOREAFTER.height} defaultProps={SBEFOREAFTER as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as StaticBeforeAfterProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }} />
      <Composition id="StaticIngredientBreakdown" component={StaticIngredientBreakdown as React.FC<Record<string, unknown>>} durationInFrames={1} fps={1} width={SBREAKDOWN.width} height={SBREAKDOWN.height} defaultProps={SBREAKDOWN as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as StaticIngredientBreakdownProps; return { durationInFrames: 1, fps: 1, width: p.width, height: p.height }; }} />
    </>
  );
};
