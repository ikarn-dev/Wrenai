import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { TestnetPageView } from "@/components/testnet/page-view";
import { testnetDatabase } from "@/server/testnet/database";
import { testnetOwner } from "@/server/testnet/session";

export default async function TestnetSectionPage({
  params,
}: {
  readonly params: Promise<{ section: string[] }>;
}) {
  if (!(await testnetOwner(testnetDatabase()))) {
    redirect("/?network=testnet");
  }
  const { section } = await params;
  const [name, id] = section;
  const allowed = z
    .enum([
      "portfolio",
      "agents",
      "chat",
      "activity",
      "claims",
      "proof",
      "settings",
      "spot",
      "perps",
      "memecoins",
    ])
    .safeParse(name);
  if (
    !allowed.success ||
    section.length > 2 ||
    (id &&
      !(name === "agents" && z.uuid().safeParse(id).success) &&
      !(name === "settings" && ["trading-access", "recovery"].includes(id)))
  ) {
    notFound();
  }
  return <TestnetPageView section={allowed.data} id={id} />;
}
