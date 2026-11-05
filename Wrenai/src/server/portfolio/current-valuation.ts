import "server-only";
import { cache } from "react";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { type PortfolioValuation, readPortfolioValuation } from "./valuation";

/**
 * The signed-in user's valuation, read once per request. The wallet tile and the value card share it, so they
 * never disagree and the price registry is fetched once.
 */
export const currentPortfolioValuation = cache(async (): Promise<PortfolioValuation> => {
  const user = await requireUser();
  return readPortfolioValuation(database(), user);
});
