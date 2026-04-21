import type { Metadata, Viewport } from "next";
import "./globals.css";

// Root font strategy: system fonts. Zero network requests, renders on
// first paint, looks native on every OS (San Francisco on macOS, Segoe
// UI on Windows, Roboto on Android). Storefront pages layer Montserrat
// on top via their own nested layout; dashboard uses the system stack.

export const viewport: Viewport = {
  themeColor: "#6366f1",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: {
    default: "ShopCX.ai - AI-Powered Customer Experience",
    template: "%s | ShopCX.ai",
  },
  description:
    "ShopCX.ai is an AI-powered customer experience platform that helps businesses deliver exceptional support through intelligent agents.",
  keywords: [
    "AI",
    "customer experience",
    "customer support",
    "AI agents",
    "ShopCX",
    "ecommerce",
    "helpdesk",
  ],
  authors: [{ name: "Superfoods Company" }],
  creator: "Superfoods Company",
  metadataBase: new URL("https://shopcx.ai"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://shopcx.ai",
    siteName: "ShopCX.ai",
    title: "ShopCX.ai - AI-Powered Customer Experience",
    description:
      "Deliver exceptional customer support through intelligent AI agents.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ShopCX.ai",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ShopCX.ai - AI-Powered Customer Experience",
    description:
      "Deliver exceptional customer support through intelligent AI agents.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ShopCX.ai",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-zinc-950">
        {children}
      </body>
    </html>
  );
}
