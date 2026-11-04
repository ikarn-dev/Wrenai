import type { ResearchTool } from "@/shared/research";

/** Decision requirements shared by every model/tool round; these do not authorize trades. */
export const DECISION_GUIDANCE: Record<ResearchTool, string> = {
  spot_trader:
    "Research the exact user's buy/sell direction, size, quote, owned tokens and costs. Clarify missing order conditions; profit exits require actual cost basis. Never claim a quote submitted a trade, infer leverage, or spend another agent's allocation.",
  dca: "Research the exact buy/pay pair, quote costs and explicit schedule. Require amount, timezone, total cap and end condition for a saved execution plan; never invent a schedule or spend from a mere research request.",
  whale_tracker: "Retired category. Do not fetch wallet records, offer monitoring or create an agent.",
  buy_the_dip:
    "Use an explicit price or drawdown from a defined rolling-high window. State reference, trigger, size, cooldown and invalidation. A quote alone does not prove a dip or authorize buying.",
  sell_the_top:
    "Evaluate user-defined net-profit targets from confirmed attributed entry fills and costs. Require sell percentages, inventory and optional trailing rule. Unknown cost basis is not profit; never predict an absolute market top.",
  rebalancer:
    "Recommend keep/rebalance/wait from actual holdings, user target weights, drift and size-specific costs. If weights/holdings are missing, explain the best conditional approach and ask only for those inputs. Never invent an allocation preference.",
  triggers:
    "Recommend a conditional entry/exit or waiting from price trend, volatility, quote costs and recent catalysts. State the time horizon and what invalidates the idea. Do not invent a user's order size or turn a breakout into a resting limit buy.",
  copy_trading:
    "Explain follow/watch/avoid using decoded public activity, repeatability, realized performance where known and follower execution costs. A few fills are not proof of skill; recommend watch rather than copy when performance is unverified.",
  yield_optimizer:
    "Rank comparable same-asset yields after known costs, liquidity/withdrawal constraints and protocol/news risks. Prefer a suitable liquid option over the highest headline APR when evidence supports it. Separate APR, rewards and redemption value; never fabricate a staking APY.",
  meme_hunter:
    "Use Squint's actual individual findings, holder coverage, listing times and supported routes. Lead with the most relevant candidates and clear avoid/watch reasoning. A clean score is not a contract audit or sell simulation. Incomplete history or unknown checks cannot be described as passed. Prefer exact token contracts; request clarification for ambiguous tickers.",
  private_payments:
    "Recommend the next setup check from recipient existence, token registration and user privacy requirement. Public account/storage checks do not establish a private transfer route. Never recommend a public downgrade as a private payment.",
  lp_manager:
    "Recommend a suitable pool or waiting by asset compatibility, liquidity, fee tier, observed volatility and withdrawal/range requirements. Explain impermanent loss and net-return uncertainty. No invented fee income, APR or owned LP positions.",
  lending_margin:
    "Recommend supply/borrow/wait from current variable rates, collateral eligibility, user objective and verified health buffer. Explain rate/withdrawal/liquidation risks. Do not recommend leverage when positions or risk capacity are missing.",
  perps:
    "Give the supported long or short bias for every named market and horizon, its strength, conditional entry, invalidation and chart-derived TP/SL hypotheses. Use only the supplied 15m/1h/4h closed-bar indicators, mark/funding, actual supplied liquidity and relevant dated news. Explain the strongest contrary fact. Do not claim order-book or size-specific liquidity was measured unless present. Do not hide a directional view behind generic timing language. Separate bias from trade eligibility: missing/stale evidence blocks a signal and risk limits block execution. Never invent indicator values, prices, probabilities or a guaranteed outcome. A technical screen and illustrative 2R target are not validated predictive accuracy or execution instructions.",
  arbitrage:
    "Recommend pursue/watch/wait using actual size-specific round-trip outputs, independent reserves and verified costs. Positive gross quotes alone are watch candidates. Do not call funding, staking carry or unmatched reference prices risk-free arbitrage; unknown net costs or leg readiness mean no confirmed executable edge.",
};
