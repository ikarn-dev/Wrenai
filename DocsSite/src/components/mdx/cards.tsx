import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  ChartCandlestick,
  Coins,
  Flame,
  HandCoins,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Rocket,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

// The icons pages may name, so MDX passes a word rather than a component. Bare icons, no tile (DESIGN.md → Icons).
const ICONS = {
  agents: BrainCircuit,
  book: BookOpen,
  chat: MessagesSquare,
  claims: HandCoins,
  coins: Coins,
  key: KeyRound,
  meme: Flame,
  perps: ChartCandlestick,
  rocket: Rocket,
  shield: ShieldCheck,
  spot: ArrowLeftRight,
  wallet: Wallet,
} as const satisfies Readonly<Record<string, LucideIcon>>;

type IconName = keyof typeof ICONS;

/** A grid of link cards, two across where there's room. */
export function Cards({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className="grid grid-cols-1 gap-stack sm:grid-cols-2">{children}</div>;
}

/** One linked card: an icon, a title and one line. The whole card is the link. */
export function Card({
  title,
  href,
  icon,
  children,
}: {
  readonly title: string;
  readonly href: string;
  readonly icon?: IconName;
  readonly children?: ReactNode;
}): ReactElement {
  const Icon = icon ? ICONS[icon] : null;
  return (
    <Link href={href} className="doc-card group flex flex-col gap-2 p-card text-left">
      {Icon ? (
        <Icon aria-hidden="true" size={20} strokeWidth={1.75} absoluteStrokeWidth className="text-fg-muted" />
      ) : null}
      <span className="flex items-center justify-between gap-2 text-h3 text-fg-strong">
        {title}
        <ArrowRight
          aria-hidden="true"
          size={16}
          strokeWidth={1.75}
          absoluteStrokeWidth
          className="shrink-0 text-fg-subtle transition-transform duration-300 ease-ios group-hover:translate-x-0.5"
        />
      </span>
      {/* MDX wraps the text in a paragraph, so its box is a div; a link may hold blocks (HTML5). */}
      {children ? <div className="text-small leading-relaxed text-fg-muted">{children}</div> : null}
    </Link>
  );
}
