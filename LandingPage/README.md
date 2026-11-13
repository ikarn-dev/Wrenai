<div align="center">
  <img src="public/assets/nobg_logo.png" alt="Wrenai" width="64">
  <h1>Wrenai Landing Page</h1>
  <p><strong>Private AI for your DeFi</strong></p>
  <p>The public home of Wrenai's private AI and trading agents.</p>
  <p>
    <a href="https://www.wrenai.xyz" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/View_Website-237359?style=for-the-badge" alt="Visit the Wrenai website"></a>
    <a href="https://app.wrenai.xyz" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Launch_App-232323?style=for-the-badge&amp;logo=near&amp;logoColor=89EDC0" alt="Launch the Wrenai app"></a>
    <a href="https://docs.wrenai.xyz" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Read_Docs-232323?style=for-the-badge&amp;logo=readthedocs&amp;logoColor=89EDC0" alt="Read the documentation"></a>
  </p>
  <p><a href="#screenshots">Screenshots</a> · <a href="#delivery-model">Delivery</a> · <a href="#setup">Setup</a> · <a href="#editing-guide">Editing guide</a></p>
</div>

---

The product website at [www.wrenai.xyz](https://www.wrenai.xyz) introduces Wrenai's private AI, trading agents and NEAR integrations. This package is a **static Next.js site**; live research and execution run in the [Wrenai application](../Wrenai/README.md).

[Repository overview](../README.md) · [Application README](../Wrenai/README.md) · [DocsSite README](../DocsSite/README.md)

## Screenshots

<table>
  <tr>
    <td width="50%" align="center">
      <h3>First impression</h3>
      <p>Brand, Jarvis prompts and product entry points.</p>
      <!-- Replace the placeholder below with a real landing-page hero capture. -->
      <br><br><em><img width="1461" height="734" alt="image" src="https://github.com/user-attachments/assets/d2e307dd-d08d-4ac3-845d-5accf0f648e6" />
</em><br><br><br>
    </td>
    <td width="50%" align="center">
      <h3>Product walkthrough</h3>
      <p>Agent workflows and the privacy boundary.</p>
      <!-- Replace the placeholder below with a real product-section capture. -->
      <br><br><em><img width="1202" height="721" alt="image" src="https://github.com/user-attachments/assets/23bf3f38-e099-4b53-a54f-545064399239" />
</em><br><br><br>
    </td>
  </tr>
</table>

---

## What it contains

- A Jarvis hero with example prompts and links into the real chat.
- Product features and visual explanations of research, execution and privacy.
- An interactive walkthrough of the seven agent families.
- Ecosystem integrations, FAQ, theme switching and accessible reduced-motion behavior.
- [`public/WRENAI.md`](public/WRENAI.md), the public product guide for external AI assistants, served at `/WRENAI.md`.
- Vercel Web Analytics for landing-page usage.

The on-page examples and animated flows illustrate behavior. They are not live balances, executable orders or settlement evidence.

## Delivery model

```mermaid
flowchart LR
    Source["React sections, styles and public assets"] --> Build["Next.js static export"]
    Build --> Files["out/ · HTML, JavaScript, CSS and assets"]
    Files --> Host["Static host / CDN"]
    Host --> Visitor[Visitor]
    Visitor -->|Launch app or send a prompt| App["app.wrenai.xyz"]
    Visitor -->|Read guides| Docs["docs.wrenai.xyz"]

    classDef accent fill:#237359,stroke:#89EDC0,color:#FFFFFF
    classDef surface fill:#232323,stroke:#5FD6A4,color:#FFFFFF
    class App,Host accent
    class Source,Build,Files,Docs surface
```

The site exports static files through [`next.config.ts`](next.config.ts). It has no trading backend, database connection or private environment variables. GSAP handles visual sequences, Lenis handles scroll behavior, and React Flow powers workflow diagrams.

## Setup

Requires **Node.js 24.22.1+** and **pnpm 11.24.0**. Run these commands from `LandingPage/`:

```sh
pnpm install --frozen-lockfile
```

No environment configuration is required for the production app links. To change their destination, copy [`.env.example`](.env.example) to `.env` and set:

```dotenv
NEXT_PUBLIC_APP_URL=https://app.wrenai.xyz
```

This value is public and resolved at build time by [`src/app-url.ts`](src/app-url.ts). Production builds require an HTTPS destination. Local development can point it at `http://localhost:3000`. Documentation links use `https://docs.wrenai.xyz`.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | User-run development server on port 3001. |
| `pnpm typecheck` | Generate route types and check TypeScript. |
| `pnpm lint` | Run Biome. |
| `pnpm build` | Export the site to `out/`. |

This package has no separate test script. Runtime and execution tests belong to the application package.

## Editing guide

| Path | Responsibility |
| --- | --- |
| `src/app/page.tsx` | Section order and page composition. |
| `src/app/layout.tsx` | Fonts, metadata, theme initialization, smooth scrolling and analytics. |
| `src/app/*.css` | Theme tokens and section styling. |
| `src/components/hero/` | Jarvis examples, prompt entry and hero visuals. |
| `src/components/sections/` | Features, agents, workflows, privacy, integrations and FAQ. |
| `src/components/agents/`, `flows/`, `privacy/` | Interactive product explanations. |
| `src/components/motion/` | Animation setup and reduced-motion handling. |
| `src/app-url.ts` | App destinations and documentation URL. |
| `public/` | Brand assets, theme bootstrap and the public AI-assistant guide. |

Keep public copy aligned with actual application behavior: exactly seven agent families, five compatible guest-testnet types, explicit public execution routes and the real backend privacy boundary. Update the public assistant guide when supported instructions or deep links change. Never put credentials, customer data or trading logic in this package.

## Deployment

Use `LandingPage` as an independent hosting project root. Install with the pinned lockfile, build with `pnpm build`, and serve `out/`. Vercel can host the static export; other static hosts need equivalent asset routing and security headers. Vercel Web Analytics requires enabling Analytics on that hosting project.

The deployed app and documentation must be reachable separately. Changing a destination requires rebuilding the landing page because links are baked into the export.
