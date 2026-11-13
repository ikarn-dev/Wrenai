# Wrenai

**A private research and execution desk built around NEAR.**

[Open the app](https://app.wrenai.xyz) · [Explore Wrenai](https://www.wrenai.xyz) · [Documentation](https://docs.wrenai.xyz)

Wrenai connects a market view to an exact, reviewable action. Research a position with Jarvis, confirm a single trade, or turn a written strategy into an agent that monitors its conditions. The same desk brings together NEAR wallet assets, confidential Intents balances, native NEAR liquidity and perpetual markets.

The distinction is in how a decision becomes executable: NEAR AI Cloud interprets the request; typed rules capture what the user approved; a deterministic Guard checks whether an action is permitted. An execution ledger tracks the submission through settlement, including pending outcomes, refunds and recoverable funds.

## What you can do

- **Research with Jarvis.** Combine market prices, chart indicators, liquidity and recent news. Stream an answer with verification pending, then check the completed model response before saving it as verified.
- **Trade or pay directly from chat.** Review an exact quote or payment card and confirm it. A one-off action needs no agent.
- **Keep a strategy running.** Define entries, schedules and exits in plain language, review the resulting rules, then fund and start the agent. Durable workflows continue checking after the browser closes.
- **Choose the execution boundary.** Use supported confidential Intents routes, or explicitly public wallet, RHEA and Hyperliquid routes. The interface keeps native NEAR and wNEAR distinct.
- **Inspect what happened.** Portfolio, Activity, Claims and Proof connect balances, agent state, recoverable funds, inference receipts and execution records.

### Seven focused agents

| Agent | Purpose |
| --- | --- |
| Private Payments | Send an exact amount to a specified recipient using a supported confidential route or an explicitly public payout. |
| DCA | Purchase a specified asset on a defined schedule, with bounded spending and expiry. |
| Spot Trader | Buy or sell an exact pair, with supported entry conditions and protective exits. |
| Perps | Trade Hyperliquid markets with reviewed size, leverage, take-profit, stop-loss and trailing rules. |
| Meme Hunter | Discover NEAR launches, evaluate token and liquidity evidence, and trade eligible routes. |
| Buy the Dip | Buy when a specified price or drawdown condition is met. |
| Sell the Top | Exit owned inventory at defined profit targets, using known cost basis rather than claiming to predict a market top. |

Agents execute reviewed rules. Model-generated prose does not sign orders or silently change a strategy. Token eligibility depends on the actual route, balance location, liquidity and venue limits.

## Why NEAR

NEAR supplies the account, inference and settlement primitives that make this desk possible:

| Building block | Role in Wrenai |
| --- | --- |
| NEAR accounts and NEP-413 | Wallet ownership verification through NEAR Connect, without a sign-in transaction. |
| NEAR AI Cloud | Encrypted inference with model attestation and response-signature verification for research and strategy interpretation. |
| NEAR Intents and 1Click | Supported cross-chain quotes, confidential swaps and payments, funding and payouts. |
| RHEA Finance | Public NEAR execution for supported pairs, including routes that deliver native NEAR, plus pool data. |
| NEAR token discovery and RPC | Discover wallet assets, verify token metadata and balances, and reconcile finalized transactions. |
| Tidepool on NEAR testnet | A separate public sandbox for supported test-token swaps and Intents balances. |

## Architecture

The repository contains three independently deployed applications. The trading backend lives inside `Wrenai`; the landing page and documentation do not hold trading credentials.

```mermaid
flowchart TB
    Visitor[Visitor]
    Landing["LandingPage · static product site"]
    Docs["DocsSite · static MDX documentation"]
    App["Wrenai · Next.js application"]
    API["Authenticated routes and server actions"]
    AI["NEAR AI Cloud · verified inference"]
    Engine["Trading engine and Guard"]
    Workflows["Vercel Workflows · durable checks"]
    Signer["Backend Signer · encrypted trading keys"]
    PG[("Supabase Postgres · durable state")]
    Redis[("Upstash Redis · limits and chat cache")]
    Venues["Mainnet · Intents / RHEA / Hyperliquid"]
    Testnet["Testnet · NEAR RPC / Tidepool"]
    Reconcile["Executor · settlement reconciliation"]

    Visitor --> Landing
    Landing --> App
    Landing --> Docs
    Docs --> App
    App --> API
    API --> AI
    API --> PG
    API --> Redis
    API --> Engine
    Workflows --> Engine
    Engine --> PG
    Engine --> Signer
    Signer --> Venues
    API --> Testnet
    Workflows --> Testnet
    Venues -->|Settlement observations| Reconcile
    Testnet -->|Testnet observations| Reconcile
    Reconcile --> PG
```

Postgres is the financial authority: reservations, strategy revisions, orders, fills and recovery state live there. Redis accelerates requests and recent encrypted chat history; it cannot approve spending. Mainnet and testnet share the configured database but use separate testnet tables and a separate migration journal.

### From instruction to settlement

```mermaid
flowchart LR
    Request[User request] --> Choice{One action or automation?}
    Choice -->|One action| Card[Exact trade or payment card]
    Choice -->|Automation| Rules[Parsed strategy and token allocation]
    Card --> Confirm[User confirmation]
    Rules --> Review[User review, funding and activation]
    Review --> Check[Durable condition checks]
    Confirm --> Validate[Fresh quote, ownership and policy checks]
    Check --> Validate
    Validate --> Submit[Wallet approval or authorized backend signing]
    Submit --> Track[Persist and reconcile the existing submission]
    Track --> Outcome[Confirmed result, refund or pending recovery]
    Outcome --> Records[Activity, Claims and Proof]
```

Scheduled checks use Vercel Workflows rather than Cron. Timing is best effort; a timeout is reconciled against the existing order instead of treated as permission to submit another one.

## Try the product

### Without a wallet

On a configured deployment, open the [app](https://app.wrenai.xyz) and choose **Try as a guest**. The shared testnet pool allocates **0.1 test NEAR, 5 test USDC and 5 test USDT** per guest, subject to pool availability and usage caps.

| Do this | What to inspect |
| --- | --- |
| Open Portfolio after entering as a guest. | Your allocation and the NEAR Testnet badge, in the same app layout. |
| Ask Jarvis: `Quote 0.5 USDC to USDT.` | A testnet quote for supported Tidepool tokens; review the balance location before confirming. |
| Confirm the card. | Submission progress, the settled balance change and an Activity record. |
| Create a DCA agent: `Spend 0.5 USDC to buy USDT every 60 seconds for 2 purchases.` | Review the parsed schedule and 1 USDC allocation; deploy and inspect the agent timeline. |
| Stop the agent and open Claims. | Funds still assigned to the stopped agent, with an explicit claim action. |

The testnet catalog contains Payments, Spot Trader, DCA, Buy the Dip and Sell the Top. Payments are public. Swaps use Tidepool's supported test tokens; native NEAR is available for payments, not Tidepool swaps. Perps, Meme Hunter and confidential routes remain mainnet-only. Connected testnet wallets can make wallet-approved manual transactions; autonomous testnet agents use guest allocations.

Tidepool is an independent sandbox, **not an official 1Click testnet**. The [hackathon brief](https://near.army/HACKATHON.md) describes the production Intents integration as mainnet-only. Testnet results do not establish mainnet liquidity, privacy or execution readiness.

### With a NEAR wallet

Connect a mainnet wallet and sign the ownership message. Research, inspect balances and request quotes before moving funds. Manual orders require an exact card confirmation. Agents can be created before trading access is configured; execution requires the relevant authorization, recovery setup and funding.

Mainnet transactions use real assets. The source includes execution adapters, but deployment configuration and live acceptance must be checked for the particular route being used. No blanket claim of production certification or guaranteed returns is made.

## Privacy and control

| Boundary | What the implementation provides |
| --- | --- |
| Model inference | NEAR AI Cloud TEE evidence and response verification; streamed text remains provisional until verified. |
| Private Intents routes | Confidential activity within the provider's supported environment. Deposits and public payouts expose their public-chain legs. |
| Public execution | Wallet transfers, RHEA swaps, Hyperliquid activity and testnet transactions are public. |
| Stored data | Chats and signing material are encrypted at rest. The Vercel backend can decrypt what it processes and the keys it uses to sign. |
| Spending authority | Exact per-agent token reservations, ownership checks, policy checks and revocable trading access. Unknown submissions retain their holds until reconciled. |

Wrenai does not claim operator-private signing. Verification establishes inference provenance, not the correctness of financial advice. A private request is never silently converted into a public payment.

## Repository guide

| Directory | Responsibility | Read next |
| --- | --- | --- |
| [`Wrenai/`](Wrenai/) | Product UI, authenticated backend, trading engine, storage and workflows. | [Application README](Wrenai/README.md) |
| [`LandingPage/`](LandingPage/) | Static product presentation and app entry points. | [Landing page README](LandingPage/README.md) |
| [`DocsSite/`](DocsSite/) | Static, searchable product documentation authored in MDX. | [Documentation site README](DocsSite/README.md) |

Each application has its own `package.json`, pinned dependencies, lockfile and deployment root. There is no root install or shared root build command. Use **Node.js 24.22.1 or newer** and **pnpm 11.24.0**, then follow the relevant README.

## Foundations and attribution

Wrenai uses Next.js, React, TypeScript and Tailwind CSS; NEAR Connect and NEAR JavaScript libraries; the NEAR AI inference SDK; the NEAR Intents 1Click SDK; Drizzle and `pg`; Vercel Workflows; Upstash Redis; TanStack Query; Radix UI, Motion, GSAP and Lenis; and MDX with remark-gfm. Exact dependency versions are recorded in each application's manifest and lockfile. Codex has been used for AI-assisted implementation and documentation.

External services include NEAR AI Cloud, NEAR Intents, RHEA, Hyperliquid, FastNear, Nearblocks, Squint, Nearly, Meme.Cooking, CoinGecko, Coinbase Exchange, Tavily, Tidepool, Vercel, Supabase and Upstash. Their responsibilities are described in the [application README](Wrenai/README.md) and [service reference](https://docs.wrenai.xyz/reference/services).

## NEAR Hackathon

The project is being developed for **NEAR HACKATHON 2026**. Its concrete areas of fit are DeFi execution, private AI, agent spending controls and the agent economy. These describe the implementation; they are not a declaration that any tracks have been submitted or accepted.

The checked-in history begins with the [initial snapshot on 1 November 2026](https://github.com/ikarn-dev/Wrenai/commit/cdfe44f). [Changes since that snapshot](https://github.com/ikarn-dev/Wrenai/compare/cdfe44f...main) are visible separately; the initial snapshot already contains application code and is not an empty baseline.

This README follows the [organizer brief](https://near.army/HACKATHON.md): identify NEAR's actual role, document reused foundations, provide observable demo steps and distinguish testnet from mainnet. Recheck the [canonical brief](https://nearhackathon.com/HACKATHON.md) before submission. Repository publication, the demo post and final submission remain owner-controlled actions. A repository-wide `LICENSE` file has not yet been added.
