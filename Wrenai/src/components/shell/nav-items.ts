import {
  ArrowLeftRight,
  BrainCircuit,
  ChartCandlestick,
  ChartPie,
  Fingerprint,
  History,
  type LucideIcon,
  MessagesSquare,
  Settings,
} from "lucide-react";
import type { Route } from "next";

interface NavItemLabel {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: "main" | "markets" | "settings";
}

export type NavItem = NavItemLabel &
  ({ readonly kind: "link"; readonly href: Route } | { readonly kind: "unavailable" });

// Unbuilt sections have no URL, so neither navigation can send the user to a missing screen.
export const NAV_ITEMS: readonly NavItem[] = [
  { kind: "link", href: "/portfolio", label: "Portfolio", icon: ChartPie, group: "main" },
  { kind: "link", href: "/agents", label: "Agents", icon: BrainCircuit, group: "main" },
  { kind: "link", href: "/chat", label: "Chat", icon: MessagesSquare, group: "main" },
  { kind: "link", href: "/activity", label: "Activity", icon: History, group: "main" },
  { kind: "link", href: "/proof", label: "Proof", icon: Fingerprint, group: "main" },
  { kind: "link", href: "/spot", label: "Spot", icon: ArrowLeftRight, group: "markets" },
  { kind: "link", href: "/perps", label: "Perps", icon: ChartCandlestick, group: "markets" },
  { kind: "link", href: "/settings", label: "Settings", icon: Settings, group: "settings" },
];

export function isNavItemActive(pathname: string, href: Route): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
