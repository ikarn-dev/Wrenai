import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { ANY_AGENT_TYPE } from "@/shared/agent-create-request";

// Older links and bookmarks: agent creation now opens as a dialog on the Agents page.
export default async function NewAgentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  await requireUser();
  const query = await searchParams;
  const next = new URLSearchParams();
  const setup = query["setup"];
  if (typeof setup === "string") {
    next.set("setup", setup);
  } else {
    const tool = query["tool"];
    next.set("create", typeof tool === "string" ? tool : ANY_AGENT_TYPE);
    for (const name of ["manual", "brief"] as const) {
      const value = query[name];
      if (typeof value === "string") {
        next.set(name, value);
      }
    }
  }
  redirect(`/agents?${next.toString()}`);
}
