import { Badge } from "@/components/ui/badge";
import type { AppNetwork } from "@/shared/network";

/** The network the app is on, beside the account pill. Switching lives in the account menu. */
export function NetworkSwitch({ network }: { readonly network: AppNetwork }) {
  return (
    <Badge tone="light" dot size="md">
      {network === "mainnet" ? "Mainnet" : "NEAR Testnet"}
    </Badge>
  );
}
