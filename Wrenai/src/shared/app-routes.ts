import type { Route } from "next";
import type { AppNetwork } from "./network";

export const TESTNET_ROUTES = {
  "/portfolio": "/testnet/portfolio",
  "/agents": "/testnet/agents",
  "/chat": "/testnet/chat",
  "/activity": "/testnet/activity",
  "/claims": "/testnet/claims",
  "/proof": "/testnet/proof",
  "/settings": "/testnet/settings",
  "/spot": "/testnet/spot",
  "/perps": "/testnet/perps",
  "/memecoins": "/testnet/memecoins",
} as const;
export type AppRoute = Route<(typeof TESTNET_ROUTES)[keyof typeof TESTNET_ROUTES]>;
export function networkRoute(network: AppNetwork, route: Route): AppRoute {
  if (network === "mainnet") {
    return route;
  }
  const entry = Object.entries(TESTNET_ROUTES).find(([key]) => key === route);
  return entry?.[1] ?? "/testnet/portfolio";
}
