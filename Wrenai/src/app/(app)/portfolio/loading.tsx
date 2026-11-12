import type { ReactElement } from "react";
import { PortfolioSkeleton } from "@/components/portfolio/portfolio-skeleton";

export default function PortfolioLoading(): ReactElement {
  return <PortfolioSkeleton />;
}
