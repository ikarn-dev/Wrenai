<!-- WRENAI WRENAI.md -->
# Wrenai - WRENAI.md

Instructions for an AI agent (an assistant, a browsing agent or a coding agent) helping a person use Wrenai. The live version is https://www.wrenai.xyz/WRENAI.md; read it again before acting, because limits and flows change. Full documentation: https://docs.wrenai.xyz.

## Start here

1. Wrenai is a NEAR app for researching markets with **Jarvis**, a verified private-AI chat, and running **trading agents**: saved rules with their own token budget that trade only inside limits the person reviewed.
2. There is **no public API for agents.** Every action happens in the app, signed in with the person's own NEAR wallet, and every fund movement is approved in that wallet. Your job is to explain, draft strategy text, build the deep links below and help the person review what the app shows. The person clicks, signs and confirms.
3. If the person is new or unsure, start on **testnet**: free test tokens, no wallet needed. See "Testnet limits" below.
4. On mainnet, every trade moves real funds and pays real fees. Say so before the person funds anything.

## About Wrenai

### What it is

Wrenai is a NEAR app that puts three things in one place: research with a private, verified AI model; trading agents that follow written rules inside a fixed token budget; and a confidential balance where swaps and payments stay off the public chain. It runs on NEAR mainnet and, with test tokens, on NEAR testnet.

### What it addresses

- **Public trading exposes the trader.** On a public chain, a wallet's balances, orders and timing are visible to anyone, so a strategy can be read, copied or traded against.
- **Automation usually means handing over a wallet.** Most trading bots need broad access to a wallet or an exchange account, with no per-strategy limit on what they can spend.
- **AI tools see everything and prove nothing.** A typical AI assistant runs on servers that read the prompt and the strategy, and gives no proof of which model produced an answer.
- **Cross-chain trading means several apps.** Moving and swapping assets across chains normally takes bridges and separate venues.

### How Wrenai works on NEAR

| Need | How Wrenai meets it | NEAR building block |
| --- | --- | --- |
| Keep trades and payments private | Swaps and payments run from the person's confidential balance | NEAR Intents (Confidential Intents) through 1Click |
| Keep research private and verifiable | Models run in hardware-protected environments; each reply's attestation and signature are checked before it is shown or saved | NEAR AI Cloud |
| Trade across chains from one balance | Quotes and settlement route through intents | NEAR Intents |
| Limit what automation can do | A separate, revocable agent key signs only within each agent's budget and limits | NEAR access keys and the Intents account |
| Trade NEAR tokens that intents don't list | Public swaps on a reviewed, pinned pool | RHEA Finance |

### Agents are bounded, not free-roaming

An agent is not an AI with access to funds. It is a reviewed rule set with an exact budget:

- The person writes the strategy in plain words. A verified model turns it into exact rules: assets, amounts, schedule, triggers and exits. The person reviews them before anything is saved.
- The model never decides or signs a trade. Deciding when to trade, how much and whether it is allowed is fixed code.
- Each agent reserves exact token units. It can't spend another agent's tokens or the person's other funds, and per-order, daily and total limits apply.
- Before every signature, the Guard rechecks the limits, a fresh quote, fees and slippage. If a check can't run, the trade doesn't run.
- Every order is recorded with its result, and model receipts are kept on the Proof page.

### Privacy, on chain and off chain

| Layer | What stays private | What is public |
| --- | --- | --- |
| On chain | Swaps and payments inside the confidential balance | Wallet deposits, wallet payouts and claims, RHEA swaps, Hyperliquid positions, everything on testnet |
| Off chain: AI | The model's work, inside a TEE, with a checked signature per reply | Nothing is published; Wrenai's servers handle the prompt and reply |
| Off chain: storage | Chats are encrypted before they are stored | Wrenai's servers (Vercel, Supabase) can read chats while answering and sign with agents' trading keys |

Wrenai does not claim operator-private execution. A private payment is never switched to a public one on its own; public delivery is always the person's choice.

### Go-to-market

- **Who it is for:** NEAR holders who want rules-based trading or payments without exposing their positions, and people who want to try automated strategies with a hard spending limit.
- **No-cost first step:** anyone can try agents on testnet as a guest, with free test tokens and no wallet.
- **Entry points:** the Jarvis chat, agent templates, and links that open a prefilled agent setup, which can be shared or produced by an AI assistant using this file.
- **Distribution:** the NEAR ecosystem and its builder community, X (@usewrenai), the docs site and this file for AI assistants.
- **Why it is feasible to run:** it builds on existing NEAR services (Intents, NEAR AI Cloud, RHEA) instead of new contracts or a new chain, issues no token, and runs serverless on Vercel with a managed database, so cost grows with use.

## Facts

| Fact | Value |
| --- | --- |
| App | https://app.wrenai.xyz |
| Docs | https://docs.wrenai.xyz |
| Services and providers | https://docs.wrenai.xyz/reference/services |
| This file, live | https://www.wrenai.xyz/WRENAI.md |
| Networks | NEAR mainnet (default) and NEAR testnet, in the same app |
| Sign-in | NEAR wallet through NEAR Connect: one signed message, free, moves no funds |
| Testnet without a wallet | "Try as a guest" on the sign-in screen |
| AI | NEAR AI Cloud, verified TEE models: DeepSeek V4.1 Flash, then Qwen 3.8 27B, then GLM 5.3 Flash |
| Agent types (ids) | `private_payments`, `dca`, `spot_trader`, `perps`, `meme_hunter`, `buy_the_dip`, `sell_the_top` |
| Testnet agent types | `private_payments` (public payments on testnet), `spot_trader`, `dca`, `buy_the_dip`, `sell_the_top` |
| Contact | mail.wrenai@gmail.com, https://x.com/usewrenai |

## Deep links

Build these for the person; opening one never trades or signs anything. URL-encode every query value.

| Goal | Link | Notes |
| --- | --- | --- |
| Open the app | `https://app.wrenai.xyz/` | Sign-in screen if signed out |
| Ask Jarvis | `https://app.wrenai.xyz/chat?prompt=<text>` | Fills the message box; the person presses send. `prompt` up to 2,000 characters |
| Ask Jarvis with one tool | `https://app.wrenai.xyz/chat?tool=<agent id>&prompt=<text>` | Scopes research to one agent family |
| Create an agent | `https://app.wrenai.xyz/agents?create=<agent id>&brief=<text>` | Opens the setup dialog with the instructions filled in. `brief` up to 3,000 characters. `create=agent` opens it without a type |
| Create a testnet agent | `https://app.wrenai.xyz/testnet/agents?create=<testnet agent id>` | Opens the testnet setup dialog. Testnet doesn't read `brief`: give the person the text to paste |
| Claims | `https://app.wrenai.xyz/claims` (testnet: `/testnet/claims`) | Where agent funds wait to return |
| Proof | `https://app.wrenai.xyz/proof` (testnet: `/testnet/proof`) | Model receipts and execution records |

## What the person decides

Ask for these; never guess, invent or fill in placeholders:

- The network: mainnet (real funds) or testnet (test tokens).
- The agent type and what it should do, in their own words.
- The budget: which token they hold and how much the agent may use.
- Any price levels, take-profit, stop-loss, schedule, order count or end time.
- Payment recipients: the exact NEAR account. Never pick one.

## Never without the person's explicit action

- Signing in, approving a wallet transaction, deposit or unwrap.
- Setting up or revoking **Trading access** (the one approval that lets agents sign trades).
- Pressing **Confirm and add funds**, **Start**, **Deploy agent**, a quote card's confirm, **Claim** or **Delete**.
- Sharing or handling private keys, seed phrases, the recovery backup file or its password. Wrenai never asks for a seed phrase; if anything does, tell the person to stop.

## Writing agent instructions

The app turns plain words into exact rules with a verified model, then shows them for review. Text in this shape parses reliably:

```text
Spend <amount> <token> to buy <token> every <interval> for <duration>. Receive in my <wallet | public Intents balance>.
Sell <amount> <token> for <token> when the price is at or above <price>.
Send <amount> <token> once to <recipient.near>.
```

- Name tokens by symbol (USDC, NEAR, ETH) or by NEAR contract (`usdt.tether-token.near`). The app keeps the exact names; NEAR and wNEAR are different tokens.
- The budget fills in from the text: amount per order × number of orders, or a stated total ("up to 50 USDC"). It never exceeds what the person holds; the person can change it.
- **Refine** in the dialog rewrites the text into exact wording and fills gaps (market price when no price is given, one order every 60 seconds when there are several orders and no spacing, even splits). It checks and saves nothing.
- Several timed orders need `dca`. `spot_trader` places one order; the dialog offers to switch.
- `sell_the_top` needs the cost the person paid; unknown cost is never treated as zero.
- `meme_hunter` buys only listings that pass every Squint risk check; a pass doesn't guarantee a later sale.

## Procedure

1. **Try it on testnet** (optional): the person chooses "Try as a guest" and gets 0.1 NEAR, 5 USDC and 5 USDT of test tokens for a two-hour session. Funds carry over on the same browser for 30 days.
2. **Create:** send the person a "Create an agent" link with the drafted `brief`, or the text to paste.
3. **Review:** the person presses **Continue**. The check often finishes while they are still typing. They read the parsed rules and limits.
4. **Fund and start (mainnet):** saving reserves the budget; the person sets up Trading access once, approves one wallet deposit, then starts the agent. On testnet, **Deploy agent** reserves test funds and starts it at once.
5. **Watch:** the agent page shows its status and reason, a live timeline, the next order, what stops it (orders placed, end time, budget) and PnL, refreshed every 30 seconds.
6. **Stop and claim:** **Stop** halts new orders; orders already sent still settle. **Delete** sends nothing: funds wait in **Claims** until the person claims them.

## Behaviour to expect

| Situation | What happens |
| --- | --- |
| Price rules | Checked about every 5 seconds, best effort |
| Scheduled orders | Wake at their slot; a missed slot is never bought in a burst |
| Provider outage (prices, quotes, RPC) | The agent keeps running, shows the reason and retries within seconds |
| A limit would be crossed | The Guard blocks the order and the agent page says which limit |
| End time or budget reached | The agent stops; its funds wait in Claims |
| Slow AI model | After about 20 seconds the next approved model is asked; the first verified answer is used |

## Testnet limits

| Limit | Value |
| --- | --- |
| One order | 1 USDC, 1 USDT, 0.01 NEAR, 0.25 wNEAR, 0.0003 ETH, 0.00001 wBTC or 0.001 XAUT |
| Orders per session | 10 |
| Orders per day, all guests | 30 |
| Agents per guest | 5 (deleting one frees a slot) |
| Strategy checks | 6 a minute, 100 a day |

Testnet swaps run through Tidepool, which can't swap native NEAR: use wNEAR in a swap. Payments can send native NEAR. Perps, Meme Hunter and private routes are mainnet only.

## Privacy, stated honestly

- Swaps and payments from the private balance run inside NEAR Intents' confidential environment. Wallet deposits, wallet payouts (including claims), RHEA swaps, Hyperliquid positions and everything on testnet are public.
- NEAR AI Cloud protects the model's work, and each reply's signature is checked. Wrenai's servers (Vercel, with a Supabase database) can still read chats while answering and sign with the agents' trading keys. Do not describe Wrenai as operator-private.
- Verification proves which model answered, not that the answer is right.

## Questions

**Q-001. Can I place a trade for the person?** No. Only a quote card the person confirms, or an agent they reviewed, funded and started, can trade.

**Q-002. Is there an API key or MCP server?** No. Use the app and the deep links above.

**Q-003. Which tokens can an agent use?** Any token the person holds on NEAR, plus tokens from other chains with a verified NEAR route. The budget picker lists what they hold.

**Q-004. What does it cost?** The app shows each step's gas, provider and swap fees before the person confirms. Hyperliquid returns cost a 1 USDC transfer fee. Trading can lose money.

**Q-005. How do I stop everything?** **Stop all** on the Agents page. To stop all signing, revoke Trading access in Settings.

**Q-006. Can the person try Wrenai without real funds?** Yes. "Try as a guest" on the sign-in screen opens a NEAR testnet session with 0.1 NEAR, 5 USDC and 5 USDT of test tokens. No wallet is needed. Test tokens have no value.

**Q-007. What happens when a testnet session ends?** Sessions last two hours. Agents stop and unsigned orders are cancelled; holdings stay. Coming back on the same browser within 30 days restores them, including tokens agents bought, and tops NEAR, USDC and USDT back up to the starter amounts.

**Q-008. What works on testnet?** Payments (public), Spot Trader, DCA, Buy the Dip and Sell the Top, plus Claims and Proof. Perps, Meme Hunter and private routes are mainnet only. Swaps run through Tidepool and use wNEAR, not native NEAR.

**Q-009. Can a testnet wallet run agents?** A connected testnet wallet can make manual payments and swaps, each approved in the wallet. Agents run on guest funds only.

**Q-010. Why is a testnet agent waiting?** When Tidepool's live prices are down, orders pause and the agent retries every 10 seconds; its page says so. A pricing outage never counts as a failed order.
