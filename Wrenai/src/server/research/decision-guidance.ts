import type { ResearchTool } from "@/shared/research";

/** Decision requirements shared by every model/tool round; these do not authorize trades. */
export const DECISION_GUIDANCE: Record<ResearchTool, string> = {
  rebalancer:
    "Recommend keep/rebalance/wait from actual holdings, user target weights, drift and size-specific costs. If weights/holdings are missing, explain the best conditional approach and ask only for those inputs. Never invent an allocation preference.",
  triggers:
    "Recommend a conditional entry/exit or waiting from price trend, volatility, quote costs and recent catalysts. State the time horizon and what invalidates the idea. Do not invent a user's order size or turn a breakout into a resting limit buy.",
  copy_trading:
    "Explain follow/watch/avoid using decoded public activity, repeatability, realized performance where known and follower execution costs. A few fills are not proof of skill; recommend watch rather than copy when performance is unverified.",
  yield_optimizer:
    "Rank comparable same-asset yields after known costs, liquidity/withdrawal constraints and protocol/news risks. Prefer a suitable liquid option over the highest headline APR when evidence supports it. Separate APR, rewards and redemption value; never fabricate a staking APY.",
  meme_hunter:
    "Recommend avoid/watch/research further from actual liquidity, token identity, launch history and credible reports. Do not infer safety, rug resistance, admin powers or exit ability from a pool listing. Unknown critical token checks favor wait/avoid.",
  private_payments:
    "Recommend the next setup check from recipient existence, token registration and user privacy requirement. Public account/storage checks do not establish a private transfer route. Never recommend a public downgrade as a private payment.",
  lp_manager:
    "Recommend a suitable pool or waiting by asset compatibility, liquidity, fee tier, observed volatility and withdrawal/range requirements. Explain impermanent loss and net-return uncertainty. No invented fee income, APR or owned LP positions.",
  lending_margin:
    "Recommend supply/borrow/wait from current variable rates, collateral eligibility, user objective and verified health buffer. Explain rate/withdrawal/liquidation risks. Do not recommend leverage when positions or risk capacity are missing.",
  perps:
    "Give a clear lean long/lean short/wait decision for the named market and horizon. Use closed-candle trend, momentum, current mark, funding, liquidity and dated relevant news. Explain two supporting facts, the strongest contrary fact and the price/condition that invalidates the view. Funding sign alone is not direction. Technical bias is conditional, not certainty; missing news must be explicit.",
  arbitrage:
    "Recommend pursue/watch/wait using actual size-specific round-trip outputs, independent reserves and verified costs. Positive gross quotes alone are watch candidates. Do not call funding, staking carry or unmatched reference prices risk-free arbitrage; unknown net costs or leg readiness mean no confirmed executable edge.",
};
