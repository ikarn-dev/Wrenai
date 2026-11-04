import "server-only";
import { createHash } from "node:crypto";
import { squintCoins, squintReport, squintToken } from "@/server/squint/client";
import {
  SQUINT_CHECKS,
  type SquintCoin,
  type SquintReport,
  SquintUnavailable,
} from "@/server/squint/contracts";
import type { ResearchInput, ResearchItem, ResearchReport, ResearchSource } from "@/shared/research";
import { decimal, displayDecimal, percent } from "./decimal";
import { intentTokens } from "./intents";

function source(token: string, observedAt: number): ResearchSource {
  return {
    id: `squint-${createHash("sha256").update(token).digest("hex").slice(0, 20)}`,
    label: "Squint token risk report",
    url: `https://www.nearsquint.tech/?q=${encodeURIComponent(token)}`,
    observedAt,
  };
}
function reportItem(report: SquintReport, listed: boolean | null): ResearchItem {
  const checkedAt = Date.parse(report.checked_at);
  const flags = report.checks.filter((check) => check.status !== "good");
  const required = SQUINT_CHECKS.map((id) => report.checks.find((check) => check.id === id));
  const unknown = required.filter((check) => !check || check.status === "unknown").length;
  return {
    id: `meme:${report.token}`,
    title: `${report.symbol} · ${report.token}`.slice(0, 160),
    kind: "market",
    status: "observed",
    metrics: [
      { label: "Contract", value: report.token },
      { label: "Created", value: report.created_at ?? "Unknown" },
      {
        label: "Provider risk",
        value: report.risk === null ? "Unscored" : `${report.risk}/100 · ${report.verdict ?? "Unknown"}`,
      },
      {
        label: "Liquidity reference",
        value:
          report.market.liquidity_near === null
            ? "Unknown"
            : `${displayDecimal(decimal(report.market.liquidity_near), 2)} NEAR`,
      },
      { label: "Creator share", value: percent(decimal(report.supply.dev)) },
      {
        label: "Checks",
        value: `${required.filter((check) => check?.status === "good").length}/${SQUINT_CHECKS.length} passed; ${unknown} unknown`,
      },
      {
        label: "Coverage",
        value: report.coverage.transfers_complete
          ? `${report.coverage.wallets_traced}/${report.coverage.wallets_checked} wallets traced; transfer history complete`
          : `${report.coverage.wallets_traced}/${report.coverage.wallets_checked} wallets traced; transfer history incomplete`,
      },
      {
        label: "Intents registry",
        value:
          listed === null ? "Unavailable" : listed ? "Listed; executable quote still required" : "Not listed",
      },
    ],
    note: (flags.length
      ? flags.map((check) => `${check.label}: ${check.status}. ${check.headline}`).join(" ")
      : "No reported flags. Independent contract/pool and size-specific entry/exit checks are still required; this is not a safety guarantee."
    ).slice(0, 500),
    sourceIds: [source(report.token, checkedAt).id],
  };
}
function listingItem(coin: SquintCoin, listed: boolean | null): ResearchItem {
  return {
    id: `meme:${coin.token}`,
    title: `${coin.symbol} · ${coin.token}`.slice(0, 160),
    kind: "market",
    status: "indicative",
    metrics: [
      { label: "Contract", value: coin.token },
      { label: "Created", value: coin.created_at ?? "Unknown" },
      {
        label: "Liquidity reference",
        value:
          coin.liquidity_near === null
            ? "Unknown"
            : `${displayDecimal(decimal(coin.liquidity_near), 2)} NEAR`,
      },
      {
        label: "Intents registry",
        value:
          listed === null ? "Unavailable" : listed ? "Listed; executable quote still required" : "Not listed",
      },
    ],
    note: "Indexed listing only. Its full risk report has not been validated in this request; no safety pass or buy recommendation is established.",
    sourceIds: ["squint-listings"],
  };
}

export async function memeResearch(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<Pick<ResearchReport, "items" | "sources" | "summary" | "limitations" | "assessment">> {
  const wanted = input.symbols.filter((value) => !["NEAR", "WNEAR"].includes(value.toUpperCase()));
  if (wanted.length > 2) {
    throw new SquintUnavailable("ambiguous", "Ask about at most two exact meme token contracts at a time.");
  }
  const [registry, discovery] = await Promise.all([
    Promise.allSettled([intentTokens(signal)]),
    wanted.length
      ? Promise.all(wanted.map((value) => squintToken(value, signal))).then((contracts) => ({
          contracts: [...new Set(contracts)],
          coins: [],
        }))
      : squintCoins(signal).then((rows) => ({
          contracts: [],
          coins: rows
            .filter((coin) => coin.created_at !== null && Date.parse(coin.created_at) <= Date.now())
            .slice(0, 5),
        })),
  ]);
  const routes =
    registry[0]?.status === "fulfilled"
      ? new Set(registry[0].value.tokens.map((token) => token.assetId))
      : null;
  const listed = (token: string): boolean | null => routes?.has(`nep141:${token}`) ?? null;
  const sources: ResearchSource[] = [],
    items: ResearchItem[] = [];
  const coins = discovery.coins;
  const contracts = wanted.length ? discovery.contracts : coins.slice(0, 2).map((coin) => coin.token);
  const reports = await Promise.allSettled(contracts.map((token) => squintReport(token, signal)));
  const failures: string[] = [];
  reports.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(reportItem(result.value, listed(result.value.token)));
      sources.push(source(result.value.token, Date.parse(result.value.checked_at)));
    } else {
      const token = contracts[index];
      if (token) {
        failures.push(`${token}: risk report unavailable.`);
      }
    }
  });
  if (!wanted.length) {
    sources.push({
      id: "squint-listings",
      label: "Squint latest indexed listings",
      url: "https://www.nearsquint.tech/api#coins",
      observedAt: Date.now(),
    });
    for (const coin of coins) {
      if (!items.some((item) => item.id === `meme:${coin.token}`)) {
        items.push(listingItem(coin, listed(coin.token)));
      }
    }
  }
  const failedChecks = reports.flatMap((result) =>
    result.status === "fulfilled"
      ? result.value.checks
          .filter((check) => check.status !== "good")
          .map((check) => `${result.value.symbol}: ${check.label} ${check.status}.`.slice(0, 300))
      : [],
  );
  return {
    items,
    sources,
    summary: wanted.length
      ? "Token-specific risk findings and route coverage. Lead with actual flagged/unknown checks; do not turn the provider score into a safety guarantee."
      : "Latest indexed NEAR listings, newest first, with full risk reports for up to two candidates. The rest are unverified discovery entries.",
    limitations: [
      "The provider screen is not a contract audit or an actual sell simulation. An executable route, independent contract/pool checks and reviewed agent limits remain mandatory.",
      "This is the newest bounded index page, not proof of every on-chain launch.",
      "An absent Intents listing does not exclude the native Nearly/wNEAR RHEA route. That route separately requires a verified raw/keyless contract profile, locked liquidity and exact-size quotes; this research does not establish eligibility.",
      ...failures.slice(0, 2),
    ],
    assessment: {
      decision: items.length > 1 ? "compare" : "wait",
      summary: failedChecks.length
        ? "Prioritize the actual flagged and unknown findings when deciding which candidates to avoid or investigate."
        : "Compare the observed candidates; a clean summary alone does not authorize buying.",
      reasons: [...failedChecks, ...failures].slice(0, 4),
      conditions: [
        "Use exact contracts rather than tickers.",
        "Missing mandatory evidence blocks an automatic entry.",
      ],
      sourceIds: sources.slice(0, 6).map((value) => value.id),
    },
  };
}
