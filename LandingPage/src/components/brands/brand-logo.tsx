import Image from "next/image";
import type { CSSProperties, ReactElement } from "react";

// The services' own logos (public/assets/brand-logos), one entry per brand. A wordmark already spells the name
// and is shown as it is; a mark needs its name written beside it, centered on the mark. 1Click is NEAR Intents' API, so it shows as
// NEAR Intents. NearBlocks' file was recolored to mint-300 (its source used currentColor, which renders black).
// Sizes are the files' own pixel or viewBox dimensions, so next/image reserves the right box.

export type BrandId =
  | "near"
  | "near-ai"
  | "near-intents"
  | "hot"
  | "rhea"
  | "fastnear"
  | "nearblocks"
  | "squint"
  | "nearly"
  | "meme-cooking"
  | "tidepool"
  | "hyperliquid";

interface BrandFile {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

type Brand =
  | {
      readonly kind: "wordmark";
      readonly name: string;
      readonly file: BrandFile;
      /** Evens out optical size: files whose letters fill less of their height draw taller. */
      readonly scale: number;
    }
  | { readonly kind: "mark"; readonly name: string; readonly file: BrandFile }
  | { readonly kind: "text"; readonly name: string };

const DIR = "/assets/brand-logos";

const BRANDS: Readonly<Record<BrandId, Brand>> = {
  near: {
    kind: "wordmark",
    name: "NEAR Protocol",
    file: { src: `${DIR}/NEAR_Protocol_Logo_0.svg`, width: 342, height: 90 },
    scale: 1,
  },
  "near-ai": {
    kind: "wordmark",
    name: "NEAR AI",
    file: { src: `${DIR}/near-ai.svg`, width: 730, height: 138 },
    scale: 0.85,
  },
  "near-intents": {
    kind: "wordmark",
    name: "NEAR Intents",
    file: { src: `${DIR}/near-intents-logo-v2a.svg`, width: 1888, height: 230 },
    scale: 0.9,
  },
  hot: {
    kind: "wordmark",
    name: "HOT Labs",
    file: { src: `${DIR}/HOT%20Dark%20BG.svg`, width: 660, height: 232 },
    scale: 1.15,
  },
  rhea: {
    kind: "mark",
    name: "RHEA Finance",
    file: { src: `${DIR}/landing-rhea-logo.svg`, width: 34, height: 31 },
  },
  // The app's NEAR RPC (rpc.mainnet.fastnear.com) and wallet-token discovery (api.fastnear.com).
  fastnear: {
    kind: "wordmark",
    name: "FastNear",
    file: { src: `${DIR}/fast-near.png`, width: 259, height: 56 },
    scale: 1.15,
  },
  nearblocks: {
    kind: "wordmark",
    name: "NearBlocks",
    file: { src: `${DIR}/nearblocks.svg`, width: 150, height: 30 },
    scale: 1.25,
  },
  squint: {
    kind: "mark",
    name: "Squint",
    file: { src: `${DIR}/near-squint-logo.jpg`, width: 400, height: 400 },
  },
  nearly: {
    kind: "mark",
    name: "Nearly",
    file: { src: `${DIR}/nearly.webp`, width: 512, height: 512 },
  },
  "meme-cooking": {
    kind: "mark",
    name: "Meme.Cooking",
    file: { src: `${DIR}/meme.cooking.png`, width: 538, height: 538 },
  },
  // The testnet swap provider (usetidepool.tech): NEAR Intents' format on NEAR testnet. Its own favicon mark.
  tidepool: {
    kind: "mark",
    name: "Tidepool",
    file: { src: `${DIR}/tidepool.svg`, width: 32, height: 32 },
  },
  hyperliquid: {
    kind: "wordmark",
    name: "Hyperliquid",
    file: { src: `${DIR}/Hyperliquid_Light.svg`, width: 856, height: 200 },
    scale: 1.2,
  },
};

/** Px heights per context: the Powered by band, and a chip or card in the diagrams. */
const SIZES = {
  band: { wordmark: 26, mark: 30, gap: "gap-2.5", text: "text-marquee font-medium text-fg-muted" },
  chip: { wordmark: 14, mark: 18, gap: "gap-1.5", text: "" },
} as const;

function height(px: number): CSSProperties {
  return { height: `${px.toString()}px`, width: "auto" };
}

/**
 * A brand as its logo: the wordmark alone (plus any missing word), or the mark with its name beside it. Raster
 * marks with their own square ground are cropped round, so they sit like app icons on the dark page.
 */
export function BrandLogo({
  brand,
  size,
}: {
  readonly brand: BrandId;
  readonly size: keyof typeof SIZES;
}): ReactElement {
  const entry = BRANDS[brand];
  const scale = SIZES[size];
  switch (entry.kind) {
    case "text":
      return <span className={scale.text}>{entry.name}</span>;
    case "wordmark":
      return (
        <Image
          src={entry.file.src}
          width={entry.file.width}
          height={entry.file.height}
          alt={entry.name}
          style={height(Math.round(scale.wordmark * entry.scale))}
          // Drawn for dark grounds; theme.css flips their lightness on the light theme.
          className="brand-wordmark shrink-0"
        />
      );
    case "mark":
      return (
        <span className={`inline-flex shrink-0 items-center ${scale.gap} ${scale.text}`}>
          <Image
            src={entry.file.src}
            width={entry.file.width}
            height={entry.file.height}
            alt=""
            style={height(scale.mark)}
            className="shrink-0 rounded-full"
          />
          <span>{entry.name}</span>
        </span>
      );
    default: {
      const unknown: never = entry;
      return unknown;
    }
  }
}
