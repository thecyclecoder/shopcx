"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSectionNav } from "@/lib/section-nav-context";
import {
  DEVELOPER_NAV,
  DEVELOPER_GROUPS,
  DEVELOPER_OVERVIEW_HREF,
  DEVELOPER_OVERVIEW_ICON,
  DEVELOPER_PORTAL_ICON,
  DEVELOPER_PULSE_HREF,
  DEVELOPER_PULSE_ICON,
  DEVELOPER_USAGE_HREF,
  DEVELOPER_USAGE_ICON,
  isInDeveloperPortal,
  isDeveloperHrefActive,
  type DeveloperBadgeKey,
} from "@/lib/developer-nav";
import type { WorkspaceWithRole } from "@/lib/types/workspace";
import NotificationBell from "@/components/notification-bell";

interface TicketView {
  id: string;
  name: string;
  filters: Record<string, string>;
  parent_id: string | null;
  count: number | null;
}

// Icons
const ICONS = {
  dashboard: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1",
  tickets: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  customers: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  subscriptions: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99",
  orders: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  returns: "M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3",
  loyalty: "M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z",
  reviews: "M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z",
  portal: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  fraud: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  chargebacks: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z",
  knowledge: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
  articles: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
  macros: "M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z",
  marketing: "M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46",
  settings: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
};

interface NavItem { href: string; label: string; icon: string; comingSoon?: boolean; adminOnly?: boolean; ownerOnly?: boolean }
interface NavSection { label: string; icon?: string; items: NavItem[]; collapsible?: boolean; ownerOnly?: boolean }

const NAV_STRUCTURE: (NavItem | NavSection)[] = [
  { href: "/dashboard", label: "Dashboard", icon: ICONS.dashboard },
  { href: "/dashboard/tickets", label: "Tickets", icon: ICONS.tickets },
  { href: "/dashboard/migrations", label: "Migration", icon: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3", ownerOnly: true },
  { href: "/dashboard/social-comments", label: "Social Comments", icon: "M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671L12 21l2.652-3.978c.26-.39.687-.634 1.153-.67 1.09-.086 2.17-.208 3.238-.365 1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" },
  // The "Org" surfaces (Message Board · Org Chart · Directors · Agents) moved into the Developer
  // portal (see lib/developer-nav DEVELOPER_GROUPS → "Org") — off the main tree.
  {
    label: "Customers",
    icon: ICONS.customers,
    collapsible: true,
    items: [
      { href: "/dashboard/customers", label: "Profiles", icon: ICONS.customers },
      { href: "/dashboard/demographics", label: "Demographics", icon: "M2.25 18L9 11.25l4.306 4.306a11.95 11.95 0 015.814-5.518l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941", adminOnly: true },
      { href: "/dashboard/subscriptions", label: "Subscriptions", icon: ICONS.subscriptions },
      { href: "/dashboard/comp-subscriptions", label: "Comp Subscriptions", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", adminOnly: true },
      { href: "/dashboard/orders", label: "Orders", icon: ICONS.orders },
      { href: "/dashboard/returns", label: "Returns", icon: ICONS.returns },
      { href: "/dashboard/replacements", label: "Replacements", icon: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" },
      { href: "/dashboard/crisis", label: "Crisis", icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" },
      { href: "/dashboard/loyalty", label: "Loyalty", icon: ICONS.loyalty },
      { href: "/dashboard/reviews", label: "Reviews", icon: ICONS.reviews },
    ],
  },
  {
    label: "Analytics",
    icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
    collapsible: true,
    items: [
      { href: "/dashboard/analytics/revenue", label: "Revenue", icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z", ownerOnly: true },
      { href: "/dashboard/analytics/mrr", label: "MRR", icon: "M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941", ownerOnly: true },
      { href: "/dashboard/analytics/roas", label: "ROAS", icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z", ownerOnly: true },
      { href: "/dashboard/analytics/profit", label: "Profit", icon: "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z", ownerOnly: true },
      { href: "/dashboard/analytics/dunning", label: "Dunning", icon: "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z", ownerOnly: true },
      { href: "/dashboard/analytics/ai", label: "AI Agent", icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z", ownerOnly: true },
      { href: "/dashboard/analytics/funnel", label: "Funnel", icon: "M3 4h18M6 9h12M9 14h6M11 19h2" },
      { href: "/dashboard/portal-analytics", label: "Portal", icon: ICONS.portal },
    ],
  },
  {
    label: "Risk",
    icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z",
    collapsible: true,
    items: [
      { href: "/dashboard/chargebacks", label: "Chargebacks", icon: ICONS.chargebacks },
      { href: "/dashboard/fraud", label: "Fraud", icon: ICONS.fraud },
      { href: "/dashboard/resellers", label: "Resellers", icon: "M3 6l3 12h12l3-12M9 6V4a3 3 0 016 0v2" },
    ],
  },
  {
    label: "Storefront",
    icon: "M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z",
    collapsible: true,
    items: [
      { href: "/dashboard/storefront/products", label: "Products", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
      { href: "/dashboard/storefront/blog", label: "Blog", icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" },
      { href: "/dashboard/storefront/ad-scorecard", label: "Ad Scorecard", icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" },
      { href: "/dashboard/storefront/optimizer", label: "Optimizer", icon: "M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z" },
      { href: "/dashboard/storefront/optimizer/tests", label: "Tests", icon: "M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" },
    ],
  },
  // Logistics: Marco's home — inventory, replenishment, supplier lead-times + the crown-jewel
  // mapping/inventory views migrated from Shoptics onto our qb_* tables. Owner-facing internal ops.
  // See docs/brain/functions/logistics.md (Crisis-aware replenishment & allocation doctrine).
  {
    label: "Logistics",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    collapsible: true,
    ownerOnly: true,
    items: [
      { href: "/dashboard/logistics/replenishment", label: "Replenishment", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
      { href: "/dashboard/logistics/inventory", label: "Inventory", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
      { href: "/dashboard/logistics/purchase-orders", label: "Purchase Orders", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
      { href: "/dashboard/logistics/lead-times", label: "Lead Times", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
      { href: "/dashboard/logistics/suppliers", label: "Suppliers", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" },
      { href: "/dashboard/logistics/mappings", label: "Mappings", icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" },
      // Crisis is Logistics-owned but cross-departmental (Logistics sets allocation policy, CS
      // executes) — cross-listed here + under Customers. See docs/brain/functions/logistics.md.
      { href: "/dashboard/crisis", label: "Crisis", icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" },
    ],
  },
  {
    label: "Knowledge",
    icon: ICONS.knowledge,
    collapsible: true,
    items: [
      { href: "/dashboard/knowledge-base", label: "Articles", icon: ICONS.articles },
      { href: "/dashboard/macros", label: "Macros", icon: ICONS.macros },
      { href: "/dashboard/products", label: "Products", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
    ],
  },
  {
    label: "Delivery",
    icon: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
    collapsible: true,
    items: [
      { href: "/dashboard/delivery/email", label: "Email", icon: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" },
      { href: "#", label: "SMS", icon: ICONS.marketing, comingSoon: true },
    ],
  },
  {
    label: "Marketing",
    icon: ICONS.marketing,
    collapsible: true,
    items: [
      { href: "/dashboard/marketing/text", label: "Text", icon: ICONS.marketing },
      { href: "/dashboard/marketing/ads", label: "Ads", icon: ICONS.marketing },
      { href: "/dashboard/marketing/landers", label: "Landers", icon: ICONS.marketing },
      // Founder-facing upload surface (content-upload-and-lander-build Phase 1). Sits under
      // Landers in the Marketing area so pending real-evidence uploads are one click away; the
      // badge shows total open lander_content_gaps on awaiting_upload blueprints.
      { href: "/dashboard/marketing/landers/content", label: "Lander uploads", icon: ICONS.marketing, ownerOnly: true },
      { href: "/dashboard/marketing/acquisition", label: "Acquisition", icon: ICONS.marketing, ownerOnly: true },
      { href: "/dashboard/marketing/social", label: "Social", icon: ICONS.marketing },
      { href: "#", label: "Email", icon: ICONS.marketing, comingSoon: true },
    ],
  },
  // Research: owner-facing home for the Acquisition Research Engine's outputs. Extensible
  // section — Competitors is surface 1 of N; add ad-gap / lander / gap-queue as siblings here
  // (one-liners) rather than under Marketing. Distinct magnifying-glass icon so it reads as
  // its own area, not a Marketing sub-tab.
  {
    label: "Research",
    icon: "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
    collapsible: true,
    ownerOnly: true,
    items: [
      { href: "/dashboard/research/competitors", label: "Competitors", icon: "M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" },
      // Research › Landers — the owner-facing window onto Rhea's URL sensor (research_urls) output.
      // Lists captured landers worthiest-first + opens the structured teardown board. Sibling to
      // Competitors under the Research section; supersedes the legacy 'Lander Teardowns' surface
      // (lander_snapshots) for competitor lander teardowns going forward.
      { href: "/dashboard/research/landers", label: "Landers", icon: "M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" },
      // Research › Teardowns — the curated gallery of successful teardowns (research_urls rows
      // carrying a structured TeardownRecipe), worthiest-first. Complements 'Landers' (all
      // classified URLs) with just the ones worth studying. Each row opens the founder-approved
      // HTML board on the Showcase (/showcase/tools/teardowns/examples/[id]). Supersedes the
      // legacy lander_snapshots teardowns surface.
      { href: "/dashboard/research/teardowns", label: "Teardowns", icon: "M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" },
    ],
  },
  // Developer is a PORTAL, not a collapsible section — clicking it lands on the Overview and the
  // sidebar takes over with the developer sub-nav (see the takeover block below + lib/developer-nav).
  { href: DEVELOPER_OVERVIEW_HREF, label: "Developer", icon: DEVELOPER_PORTAL_ICON, ownerOnly: true },
  { href: "/dashboard/settings", label: "Settings", icon: ICONS.settings },
];

// Legacy flat list for ticket view handling
const NAV_ITEMS = NAV_STRUCTURE.flatMap(item =>
  "items" in item ? item.items : [item]
).filter(item => !("items" in item)) as NavItem[];

export default function Sidebar({
  workspace,
  user,
}: {
  workspace: WorkspaceWithRole;
  user: { id: string; email: string; name?: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { nav: sectionNav } = useSectionNav(); // contextual takeover (a section page registers its sub-nav)
  const activeSection = searchParams.get("s") || (sectionNav?.sections[0]?.key ?? "");
  // Developer is a portal: a pathname-driven sidebar takeover (same UX as a director profile, but the
  // member routes are a fixed set, so it's detected from the path rather than registered per-page).
  const inDeveloperPortal = workspace.role === "owner" && !sectionNav && isInDeveloperPortal(pathname);
  const [open, setOpen] = useState(false);
  const [ticketViews, setTicketViews] = useState<TicketView[]>([]);
  const [collapsedViews, setCollapsedViews] = useState<Set<string>>(new Set());
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [escalationCounts, setEscalationCounts] = useState<{ open: number; pending: number; closed: number }>({ open: 0, pending: 0, closed: 0 });
  const [fraudCount, setFraudCount] = useState<{ count: number; maxSeverity: string }>({ count: 0, maxSeverity: "low" });
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0); // items the current viewer can approve
  const [rejectedCount, setRejectedCount] = useState(0); // "Rejected → me" pile
  const [branchesCount, setBranchesCount] = useState(0); // open claude/* PRs
  const [improveWaitingCount, setImproveWaitingCount] = useState(0); // Improve sessions waiting on you
  const [humanTestCount, setHumanTestCount] = useState(0); // spec-test human checks waiting on you (owner)
  const [regressionCount, setRegressionCount] = useState(0); // shipped specs failing their own spec-test (owner)
  const [approvalsCount, setApprovalsCount] = useState(0); // approvals escalated to the CEO (Henry)
  const [securityCount, setSecurityCount] = useState(0); // surfaced security findings (Vault, owner)
  const [landerUploadCount, setLanderUploadCount] = useState(0); // open lander_content_gaps on awaiting_upload blueprints (owner)

  // Close sidebar on route change (mobile), auto-expand tickets when on tickets page
  useEffect(() => {
    setOpen(false);
    if (pathname.startsWith("/dashboard/tickets")) setTicketsExpanded(true);
    // Auto-expand the section containing the active page
    for (const entry of NAV_STRUCTURE) {
      if ("items" in entry) {
        const section = entry as NavSection;
        if (section.items.some(i => i.href !== "#" && pathname.startsWith(i.href))) {
          setExpandedSections(prev => {
            if (prev.has(section.label)) return prev;
            const next = new Set(prev);
            next.add(section.label);
            return next;
          });
        }
      }
    }
  }, [pathname]);

  // Load ticket views + counts — poll every 60s.
  // NOTE: intentionally NOT depending on `pathname` — see the poll comment at the
  // end of this effect. Route changes must not tear down the interval and re-fire
  // the whole fan-out (that was the dominant multiplier on the RLS `set_config`
  // hot query — the failure mode this session addresses).
  useEffect(() => {
    const fetchCounts = () => {
      fetch(`/api/workspaces/${workspace.id}/ticket-views`)
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setTicketViews(d); })
        .catch(() => {});
      Promise.all([
        fetch(`/api/tickets?status=open&escalation_mine=true&limit=1`).then(r => r.json()),
        fetch(`/api/tickets?status=pending&escalation_mine=true&limit=1`).then(r => r.json()),
        fetch(`/api/tickets?status=closed&escalation_mine=true&limit=1`).then(r => r.json()),
      ]).then(([o, p, c]) => {
        setEscalationCounts({ open: o?.total || 0, pending: p?.total || 0, closed: c?.total || 0 });
      }).catch(() => {});
      // Fraud case count (admin/owner only)
      fetch(`/api/workspaces/${workspace.id}/fraud-cases?status=open&limit=1`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return;
          const count = d.total || 0;
          const cases = d.cases || [];
          const maxSeverity = cases.some((c: { severity: string }) => c.severity === "high") ? "high"
            : cases.some((c: { severity: string }) => c.severity === "medium") ? "medium" : "low";
          setFraudCount({ count, maxSeverity });
        })
        .catch(() => {});

      fetch(`/api/workspaces/${workspace.id}/reviews?status=pending&limit=1`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.stats?.pending != null) setPendingReviewCount(d.stats.pending); })
        .catch(() => {});

      // Agent To-Do system: approvable-queue bubble + "Rejected → me" pile.
      fetch(`/api/todos?status=pending&limit=1`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.approvable_count != null) setTodoCount(d.approvable_count); })
        .catch(() => {});
      fetch(`/api/escalated`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.chips?.rejected_me != null) setRejectedCount(d.chips.rejected_me); })
        .catch(() => {});
      // Improve Queue: count of box Improve sessions waiting on you (Answered / Needs approval / Error).
      fetch(`/api/tickets/improve-queue`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.counts?.waiting != null) setImproveWaitingCount(d.counts.waiting); })
        .catch(() => {});
      if (["owner", "admin"].includes(workspace.role)) {
        fetch(`/api/branches`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.total != null) setBranchesCount(d.total); })
          .catch(() => {});
      }
      // Spec-test human-test queue + regressions — both surfaced from the same endpoint, split into
      // two badges: needs-human checks (Human-test queue) vs shipped specs failing their own spec-test (Regressions).
      if (workspace.role === "owner") {
        fetch(`/api/developer/spec-test/human-queue`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (d?.counts) {
              setHumanTestCount(d.counts.waiting || 0);
              setRegressionCount(d.counts.regressions || 0);
            }
          })
          .catch(() => {});
        // Approvals escalated to the CEO (Henry) — the routed-to-CEO queue, lightweight count-only path.
        fetch(`/api/developer/approvals?count=1`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.escalatedCount != null) setApprovalsCount(d.escalatedCount); })
          .catch(() => {});
        // Vault's surfaced security findings (real-vuln fix awaiting Build / needs-human) — count-only.
        fetch(`/api/developer/security-tests?count=1`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.surfacedCount != null) setSecurityCount(d.surfacedCount); })
          .catch(() => {});
        // Lander uploads: open lander_content_gaps on awaiting_upload blueprints (owner surface).
        fetch(`/api/marketing/landers/blueprints?workspaceId=${workspace.id}&count=1`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.pending_uploads != null) setLanderUploadCount(d.pending_uploads); })
          .catch(() => {});
      }
    };
    fetchCounts();
    // Poll every 60s: this effect fires ~13 authenticated API requests per tick
    // (up to ~5 more for owner/admin), each making several PostgREST round-trips
    // that re-run the per-request RLS set_config statement — the dominant
    // high_call_volume family. Prior widens 10s→30s (queryid -7821780334453251234)
    // and 30s→60s (queryid -7726440967385220442) each addressed a follow-on offender;
    // the DB Health Agent then flagged queryid 2430642232831032083 (same
    // set_config-class high_call_volume pattern) and the lever was the RE-FIRING
    // multiplier from the `[workspace.id, pathname]` dep list — dropping `pathname`
    // kept the interval alive across navigations. The agent then flagged queryid
    // 5250820927256751610 (same set_config-class high_call_volume pattern, signature
    // dbhealth:slowq:5250820927256751610) — with widening bottomed out and the
    // re-firing gone, the next remaining lever is the BACKGROUND-TAB multiplier:
    // any dashboard tab left open (a common state for an operator flipping between
    // apps all day) keeps firing the full 13-17-request fan-out every 60s despite
    // the user not looking at it. document.visibilityState lets us skip the tick
    // while hidden (the counts are for a badge the user can't see) and refresh
    // immediately on visibilitychange to visible so badges are fresh the moment
    // the tab returns to the foreground. Counts change on events, not routes, so
    // deferring while hidden is safe.
    const runPoll = () => { if (document.visibilityState === "visible") fetchCounts(); };
    const onVisibility = () => { if (document.visibilityState === "visible") fetchCounts(); };
    const interval = setInterval(runPoll, 60000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspace.id]);

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  // The live badge for a developer-portal item (reuses the same counts the old section badges read).
  const devBadge = (key?: DeveloperBadgeKey) => {
    if (!key) return null;
    const map: Record<DeveloperBadgeKey, { n: number; cls: string }> = {
      approvals: { n: approvalsCount, cls: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400" },
      security: { n: securityCount, cls: "bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400" },
      regressions: { n: regressionCount, cls: "bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400" },
      humanQA: { n: humanTestCount, cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
      branches: { n: branchesCount, cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
    };
    const b = map[key];
    if (!b || b.n <= 0) return null;
    return (
      <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums ${b.cls}`}>{b.n > 99 ? "99+" : b.n}</span>
    );
  };
  const devHrefs = DEVELOPER_NAV.map((i) => i.href);

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Image src="/logo.svg" alt="ShopCX.ai" width={28} height={28} />
          <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            Shop<span className="text-indigo-500">CX</span>
            <span className="text-sm font-medium text-violet-400">.ai</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <NotificationBell />
          {/* Close button - mobile only */}
        <button
          onClick={() => setOpen(false)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 md:hidden dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        </div>
      </div>

      {/* Workspace name */}
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {workspace.name}
        </p>
        <p className="text-sm capitalize text-zinc-400">
          {workspace.role.replace("_", " ")}
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {/* Contextual takeover — a section page (e.g. a director profile) replaces the main nav with its own. */}
        {sectionNav && (
          <div className="space-y-0.5">
            <Link
              href={sectionNav.backHref}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
              {sectionNav.backLabel}
            </Link>
            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{sectionNav.title}</p>
            {sectionNav.sections.map((s) => {
              const active = activeSection === s.key;
              return (
                <Link
                  key={s.key}
                  href={`${sectionNav.basePath}?s=${s.key}`}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  }`}
                >
                  {s.icon && <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d={s.icon} /></svg>}
                  {s.label}
                </Link>
              );
            })}
          </div>
        )}
        {/* Developer portal takeover — pathname-driven (the member routes are a fixed set). Mirrors the
            director-profile takeover visually: back to the main nav + the developer sub-nav with badges. */}
        {inDeveloperPortal && (
          <div className="space-y-0.5">
            <Link
              href="/dashboard"
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
              Dashboard
            </Link>
            <p className="px-3 pb-0.5 pt-2 text-[12px] font-semibold text-zinc-700 dark:text-zinc-200">Developer</p>
            <Link
              href={DEVELOPER_OVERVIEW_HREF}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                pathname === DEVELOPER_OVERVIEW_HREF
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d={DEVELOPER_OVERVIEW_ICON} /></svg>
              Overview
            </Link>
            {/* founder-pulse Phase 3 — Pulse sits directly beneath Overview (per spec), before the DEVELOPER_GROUPS
                render, reusing Overview's active-state styling so the visual weight matches. */}
            <Link
              href={DEVELOPER_PULSE_HREF}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                pathname === DEVELOPER_PULSE_HREF
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d={DEVELOPER_PULSE_ICON} /></svg>
              Pulse
            </Link>
            {/* fleet-usage-cockpit Phase 3 — Usage sits directly BELOW Pulse (per spec) as the
                second peer link before the DEVELOPER_GROUPS render, matching the Pulse styling. */}
            <Link
              href={DEVELOPER_USAGE_HREF}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                pathname === DEVELOPER_USAGE_HREF
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d={DEVELOPER_USAGE_ICON} /></svg>
              Usage
            </Link>
            {DEVELOPER_GROUPS.map((group) => (
              <div key={group.heading} className="pt-1">
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{group.heading}</p>
                {group.items.map((item) => {
                  const active = isDeveloperHrefActive(pathname, item.href, devHrefs);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d={item.icon} /></svg>
                      <span className="flex-1">{item.label}</span>
                      {devBadge(item.badge)}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {!sectionNav && !inDeveloperPortal && NAV_STRUCTURE.map((entry, idx) => {
          // Section with children
          if ("items" in entry) {
            const section = entry as NavSection;
            if (section.ownerOnly && workspace.role !== "owner") return null;
            const isExpanded = expandedSections.has(section.label);
            const sectionHasActive = section.items.some(i => pathname.startsWith(i.href) && i.href !== "#");
            return (
              <div key={section.label}>
                <button
                  type="button"
                  onClick={() => setExpandedSections(prev => {
                    const next = new Set(prev);
                    if (next.has(section.label)) next.delete(section.label); else next.add(section.label);
                    return next;
                  })}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 md:py-2 text-[15px] md:text-sm transition-colors ${
                    sectionHasActive
                      ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  {section.icon && (
                    <svg className="h-5 w-5 md:h-4 md:w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={section.icon} />
                    </svg>
                  )}
                  <span className="flex-1 text-left">{section.label}</span>
                  <span className={`text-zinc-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}>&#9656;</span>
                </button>
                {isExpanded && (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                    {section.items.map(item => {
                      if (item.adminOnly && !["owner", "admin"].includes(workspace.role)) return null;
                      if (item.ownerOnly && workspace.role !== "owner") return null;
                      // Most-specific-wins: a parent (e.g. /dashboard/roadmap) isn't active when a longer
                      // sibling (e.g. /dashboard/roadmap/box) also matches — otherwise both light up. Use a
                      // "/" boundary so /dashboard/roadmap doesn't match /dashboard/roadmap-foo.
                      const isActive =
                        pathname === item.href ||
                        (item.href !== "#" &&
                          pathname.startsWith(item.href + "/") &&
                          !section.items.some(
                            (o) =>
                              o.href !== "#" &&
                              o.href.length > item.href.length &&
                              (pathname === o.href || pathname.startsWith(o.href + "/")),
                          ));
                      return (
                        <Link
                          key={item.href + item.label}
                          href={item.comingSoon ? "#" : item.href}
                          className={`flex items-center gap-2.5 rounded-md px-2.5 py-2.5 md:py-1.5 text-[15px] md:text-sm transition-colors ${
                            item.comingSoon
                              ? "cursor-default text-zinc-300 dark:text-zinc-600"
                              : isActive
                              ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          }`}
                          onClick={item.comingSoon ? (e) => e.preventDefault() : undefined}
                        >
                          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                          </svg>
                          <span className="flex-1">{item.label}</span>
                          {item.comingSoon && (
                            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400 dark:bg-zinc-800">Soon</span>
                          )}
                          {item.href === "/dashboard/reviews" && pendingReviewCount > 0 && (
                            <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400">
                              {pendingReviewCount > 99 ? "99+" : pendingReviewCount}
                            </span>
                          )}
                          {item.href === "/dashboard/fraud" && fraudCount.count > 0 && (
                            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                              fraudCount.maxSeverity === "high"
                                ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                                : fraudCount.maxSeverity === "medium"
                                ? "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400"
                                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"
                            }`}>
                              {fraudCount.count > 99 ? "99+" : fraudCount.count}
                            </span>
                          )}
                          {item.href === "/dashboard/branches" && branchesCount > 0 && (
                            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              {branchesCount > 99 ? "99+" : branchesCount}
                            </span>
                          )}
                          {/* Advisory badge (fold-on-spec-test-pass, task #29): human QA pending, never blocks the
                              fold — so neutral zinc, not an amber "to-do" alert. */}
                          {item.href === "/dashboard/developer/spec-tests/human-queue" && humanTestCount > 0 && (
                            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              {humanTestCount > 99 ? "99+" : humanTestCount}
                            </span>
                          )}
                          {item.href === "/dashboard/developer/regressions" && regressionCount > 0 && (
                            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                              {regressionCount > 99 ? "99+" : regressionCount}
                            </span>
                          )}
                          {/* Approvals escalated to you — amber "needs you" alert. */}
                          {item.href === "/dashboard/developer/approvals" && approvalsCount > 0 && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                              {approvalsCount > 99 ? "99+" : approvalsCount}
                            </span>
                          )}
                          {/* Vault's open security findings — rose alert (a vuln/needs-human awaiting you). */}
                          {item.href === "/dashboard/developer/security-tests" && securityCount > 0 && (
                            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                              {securityCount > 99 ? "99+" : securityCount}
                            </span>
                          )}
                          {/* Lander uploads: amber "needs you" — a Cleo blueprint is waiting on real-evidence assets. */}
                          {item.href === "/dashboard/marketing/landers/content" && landerUploadCount > 0 && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                              {landerUploadCount > 99 ? "99+" : landerUploadCount}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          // Top-level item (Dashboard, Tickets, Developer, Settings)
          const item = entry as NavItem;
          if (item.ownerOnly && workspace.role !== "owner") return null;
          if (item.adminOnly && !["owner", "admin"].includes(workspace.role)) return null;
          const isActive = pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const isTickets = item.href === "/dashboard/tickets";

          // Add separator before Settings — hide for non-admin roles
          const isSettings = item.href === "/dashboard/settings";
          if (isSettings && !["owner", "admin"].includes(workspace.role)) return null;

          // Branches surface — owner only (routine PRs).
          const isBranches = item.href === "/dashboard/branches";
          if (isBranches && workspace.role !== "owner") return null;

          return (
            <div key={item.href}>
              {isTickets ? (
                <button
                  type="button"
                  onClick={() => setTicketsExpanded(prev => !prev)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 md:py-2 text-[15px] md:text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  <svg className="h-5 w-5 md:h-4 md:w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                  <span className="flex-1 text-left">{item.label}</span>
                  <span className={`text-zinc-400 transition-transform ${ticketsExpanded ? "rotate-90" : ""}`}>&#9656;</span>
                </button>
              ) : (
                <Link
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2.5 md:py-2 text-[15px] md:text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  <svg className="h-5 w-5 md:h-4 md:w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                  <span className="flex-1">{item.label}</span>
                  {isBranches && branchesCount > 0 && (
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {branchesCount > 99 ? "99+" : branchesCount}
                    </span>
                  )}
                </Link>
              )}
              {/* Agent To-Do system: To Do queue + Escalated observability */}
              {isTickets && ticketsExpanded && (
                <div className="ml-6 mt-1 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-700">
                  <Link
                    href="/dashboard/tickets/todos"
                    className={`flex items-center justify-between rounded px-2 py-1 text-sm ${
                      pathname.startsWith("/dashboard/tickets/todos")
                        ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <span>To Do</span>
                    {todoCount > 0 && (
                      <span className="rounded-full bg-teal-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-teal-600 dark:bg-teal-900/30 dark:text-teal-400">
                        {todoCount > 99 ? "99+" : todoCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    href="/dashboard/tickets/escalated"
                    className={`flex items-center justify-between rounded px-2 py-1 text-sm ${
                      pathname === "/dashboard/tickets/escalated"
                        ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <span>Escalated</span>
                    {rejectedCount > 0 && (
                      <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                        {rejectedCount > 99 ? "99+" : rejectedCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    href="/dashboard/tickets/improve"
                    className={`flex items-center justify-between rounded px-2 py-1 text-sm ${
                      pathname.startsWith("/dashboard/tickets/improve")
                        ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <span>Improve</span>
                    {improveWaitingCount > 0 && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                        {improveWaitingCount > 99 ? "99+" : improveWaitingCount}
                      </span>
                    )}
                  </Link>
                </div>
              )}

              {/* Escalations submenu (legacy escalation_mine views) */}
              {isTickets && ticketsExpanded && (() => {
                const totalEsc = escalationCounts.open + escalationCounts.pending + escalationCounts.closed;
                if (totalEsc === 0) return null;
                const escCollapsed = collapsedViews.has("__escalations");
                const escItems = [
                  { label: "Open", status: "open", count: escalationCounts.open },
                  { label: "Pending", status: "pending", count: escalationCounts.pending },
                  { label: "Closed", status: "closed", count: escalationCounts.closed },
                ].filter(e => e.count > 0);

                return (
                  <div className="ml-6 mt-1 space-y-0.5 border-l border-amber-200 pl-2 dark:border-amber-800">
                    <button
                      type="button"
                      onClick={() => {
                        setCollapsedViews(prev => {
                          const next = new Set(prev);
                          if (next.has("__escalations")) next.delete("__escalations"); else next.add("__escalations");
                          return next;
                        });
                      }}
                      className="flex w-full items-center justify-between px-2 py-1 text-sm font-medium text-amber-600 dark:text-amber-400"
                    >
                      <span>
                        <span className={`mr-1 inline-block transition-transform ${escCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                        Escalations
                      </span>
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-sm font-medium tabular-nums text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                        {totalEsc > 99 ? "99+" : totalEsc}
                      </span>
                    </button>
                    {!escCollapsed && (
                      <div className="ml-3 space-y-0.5 border-l border-amber-200 pl-2 dark:border-amber-800">
                        {escItems.map(e => (
                          <Link
                            key={e.status}
                            href={`/dashboard/tickets?status=${e.status}&escalation_mine=true`}
                            className="flex items-center justify-between rounded px-2 py-1 text-sm text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
                          >
                            <span>{e.label}</span>
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-sm tabular-nums text-amber-500 dark:bg-amber-900/20">
                              {e.count > 99 ? "99+" : e.count}
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Ticket views submenu (nested) */}
              {isTickets && ticketsExpanded && ticketViews.length > 0 && (() => {
                const topLevel = ticketViews.filter(v => !v.parent_id);
                const children = (parentId: string) => ticketViews.filter(v => v.parent_id === parentId);
                const grandChildren = (parentId: string) => ticketViews.filter(v => v.parent_id === parentId);
                const currentViewId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;

                const toggleCollapse = (id: string) => {
                  setCollapsedViews(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  });
                };

                const ViewLink = ({ view, indent }: { view: TicketView; indent: number }) => {
                  const hasFilters = Object.keys(view.filters || {}).length > 0;
                  const viewHref = hasFilters ? `/dashboard/tickets?view=${view.id}` : "#";
                  const isViewActive = pathname === "/dashboard/tickets" && currentViewId === view.id;
                  const subs = indent === 0 ? children(view.id) : grandChildren(view.id);
                  const isFolder = subs.length > 0;
                  const isCollapsed = collapsedViews.has(view.id);
                  const countLabel = view.count != null
                    ? view.count > 99 ? "99+" : String(view.count)
                    : null;

                  return (
                    <div>
                      {hasFilters ? (
                        <div className={`flex items-center rounded text-sm transition-colors ${
                          isViewActive
                            ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                        }`}>
                          {isFolder && (
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); toggleCollapse(view.id); }}
                              className="shrink-0 px-1 py-1 text-zinc-400 hover:text-zinc-600"
                            >
                              <span className={`inline-block transition-transform ${isCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                            </button>
                          )}
                          <Link href={viewHref} className={`flex flex-1 items-center justify-between py-1 ${isFolder ? "pr-2" : "px-2"}`}>
                            <span>{view.name}</span>
                            {countLabel && (
                              <span className={`ml-1 rounded-full px-1.5 py-0.5 text-sm font-medium tabular-nums ${
                                isViewActive
                                  ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-300"
                                  : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                              }`}>
                                {countLabel}
                              </span>
                            )}
                          </Link>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => isFolder && toggleCollapse(view.id)}
                          className="flex w-full items-center px-2 py-1 text-sm font-medium text-zinc-400 dark:text-zinc-500"
                        >
                          {isFolder && (
                            <span className={`mr-1 inline-block transition-transform ${isCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                          )}
                          {view.name}
                        </button>
                      )}
                      {isFolder && !isCollapsed && indent < 2 && (
                        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                          {subs.map(sub => <ViewLink key={sub.id} view={sub} indent={indent + 1} />)}
                        </div>
                      )}
                    </div>
                  );
                };

                return (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                    {topLevel.map(view => <ViewLink key={view.id} view={view} indent={0} />)}
                  </div>
                );
              })()}
              {/* View All + AI Analysis links — always visible when tickets expanded */}
              {isTickets && ticketsExpanded && (
                <div className="ml-6 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  <Link
                    href="/dashboard/tickets"
                    className={`flex items-center px-2.5 py-2.5 md:py-1.5 text-[15px] md:text-sm transition-colors ${
                      pathname === "/dashboard/tickets" && !new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("view") && !new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("escalation_mine")
                        ? "font-medium text-indigo-600 dark:text-indigo-400"
                        : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    }`}
                  >
                    View All
                  </Link>
                  {["owner", "admin"].includes(workspace.role) && (
                    <>
                      <Link
                        href="/dashboard/ai-analysis"
                        className={`flex items-center px-2.5 py-2.5 md:py-1.5 text-[15px] md:text-sm transition-colors ${
                          pathname.startsWith("/dashboard/ai-analysis")
                            ? "font-medium text-indigo-600 dark:text-indigo-400"
                            : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                        }`}
                      >
                        AI Analysis
                      </Link>
                      <Link
                        href="/dashboard/csat"
                        className={`flex items-center px-2.5 py-2.5 md:py-1.5 text-[15px] md:text-sm transition-colors ${
                          pathname.startsWith("/dashboard/csat")
                            ? "font-medium text-indigo-600 dark:text-indigo-400"
                            : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                        }`}
                      >
                        CSAT
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {user.name || user.email}
            </p>
            {user.name && (
              <p className="truncate text-sm text-zinc-400">{user.email}</p>
            )}
          </div>
          <button
            onClick={handleSignOut}
            className="ml-2 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Sign out"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile header bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-md md:hidden dark:border-zinc-800 dark:bg-zinc-900/80">
        <button
          onClick={() => setOpen(true)}
          className="rounded p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <Image src="/logo.svg" alt="ShopCX.ai" width={24} height={24} />
        <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
          Shop<span className="text-indigo-500">CX</span>
          <span className="text-sm font-medium text-violet-400">.ai</span>
        </span>
      </div>

      {/* Desktop sidebar - always visible */}
      <aside className="hidden w-60 flex-col border-r border-zinc-200 bg-white md:flex dark:border-zinc-800 dark:bg-zinc-900">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar - overlay */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-white pt-[env(safe-area-inset-top)] md:hidden dark:bg-zinc-900">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
