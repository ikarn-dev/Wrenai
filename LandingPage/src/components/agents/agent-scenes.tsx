import { ArrowUp, ChevronDown } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { type Candle, CandleChart } from "./agent-charts";
import type { AgentPack } from "./agent-data";
import { DcaLifecycle, PaymentLifecycle, SpotLifecycle } from "./agent-lifecycle";
import { MemeHunt } from "./agent-meme";

// One scene per agent, each drawn as the thing that agent works with. Every number and instruction is from the
// app's example setups (Wrenai/src/shared/agent-templates.ts, shortened only by cutting clauses); a mint tag is a
// value the user fills in. Charts are drawn shapes, not market data. Every scene fills the stage, so the panel
// never shows empty space.

const STROKE = { strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

/** A value the user fills in. */
function Tag({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="agent-tag">{children}</span>;
}

/**
 * The card a scene sits on: a title and a detail on the right, then its content. It fills the stage unless
 * another card below does (`grow={false}`).
 */
function Card({
  title,
  aside,
  grow = true,
  children,
}: {
  readonly title: string;
  readonly aside?: string;
  readonly grow?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div data-slide-part className={grow ? "agent-scene flex-1" : "agent-scene"}>
      <div className="flex items-center justify-between gap-3 pb-2">
        <span className="text-body font-medium text-fg-strong">{title}</span>
        {aside ? <span className="text-small text-fg-subtle">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A label and its value on one line, split from the next by a hairline. */
function Row({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="agent-row">
      <span className="text-body text-fg-subtle">{label}</span>
      <span className="flex flex-wrap items-center justify-end gap-1.5 text-body text-fg">{children}</span>
    </div>
  );
}

interface InstructionPart {
  readonly id: number;
  readonly text: string;
  readonly tag: boolean;
}
/** Splits an instruction into plain text and the {{values}} the user fills in; each part keyed by its offset. */
function instructionParts(text: string): readonly InstructionPart[] {
  const parts: InstructionPart[] = [];
  let offset = 0;
  for (const [position, piece] of text.split(/\{\{(.+?)\}\}/).entries()) {
    const tag = position % 2 === 1;
    if (piece) {
      parts.push({ id: offset, text: piece, tag });
    }
    offset += piece.length + (tag ? 4 : 0);
  }
  return parts;
}

/**
 * The agent written the way the app takes it: plain words in a chat composer, after the user's reference. Two
 * pills above set the kind of plan; the values the user fills in are mint tags. The composer takes its text's
 * height; the agent's lifecycle below it fills the rest.
 */
function Composer({
  pills,
  text,
}: {
  readonly pills: readonly [string, string];
  readonly text: string;
}): ReactElement {
  return (
    <>
      <div data-slide-part className="flex gap-2">
        {pills.map((pill) => (
          <span key={pill} className="agent-select">
            {pill}
            <ChevronDown size={14} {...STROKE} />
          </span>
        ))}
      </div>
      <div data-slide-part className="agent-composer">
        <p className="agent-composer-text text-fg">
          {instructionParts(text).map((part) =>
            part.tag ? <Tag key={part.id}>{part.text}</Tag> : <span key={part.id}>{part.text}</span>,
          )}
        </p>
        <span aria-hidden="true" className="agent-send">
          <ArrowUp size={16} {...STROKE} />
        </span>
      </div>
    </>
  );
}

function PaymentsScene(): ReactElement {
  return (
    <>
      <Card title="Payment" aside="Once" grow={false}>
        <Row label="To">
          <Tag>recipient account</Tag>
        </Row>
        <Row label="Amount">
          <Tag>amount</Tag>
          <Tag>token</Tag>
        </Row>
      </Card>
      <PaymentLifecycle />
    </>
  );
}

function DcaScene(): ReactElement {
  return (
    <>
      <Composer
        pills={["Every 12 hours", "Up to 4 buys"]}
        text="Spend {{amount}} {{pay token}} to buy {{buy token}} every 12 hours. Make up to four buys. Skip missed buys and expire in three days."
      />
      <DcaLifecycle />
    </>
  );
}

function SpotScene(): ReactElement {
  return (
    <>
      <Composer
        pills={["Buy", "At market"]}
        text="Spend {{amount}} {{pay token}} to buy {{buy token}} once at market. Measure prices in the pay token. Take profit at {{take profit price}} and stop at {{stop loss price}}. Expire in seven days."
      />
      <SpotLifecycle />
    </>
  );
}

// Drawn candles on the chart's 0–100 scale: an uptrend through the entry, a fall through the dip level, a climb
// through two profit targets.
const PERPS_CANDLES: readonly Candle[] = [
  { o: 32, h: 36, l: 28, c: 30 },
  { o: 30, h: 34, l: 27, c: 33 },
  { o: 33, h: 38, l: 31, c: 36 },
  { o: 36, h: 40, l: 33, c: 34 },
  { o: 34, h: 42, l: 33, c: 41 },
  { o: 41, h: 45, l: 39, c: 44 },
  { o: 44, h: 46, l: 40, c: 42 },
  { o: 42, h: 49, l: 41, c: 48 },
  { o: 48, h: 53, l: 46, c: 52 },
  { o: 52, h: 54, l: 48, c: 50 },
  { o: 50, h: 57, l: 49, c: 56 },
  { o: 56, h: 61, l: 54, c: 60 },
  { o: 60, h: 63, l: 57, c: 58 },
  { o: 58, h: 66, l: 57, c: 64 },
];
const DIP_CANDLES: readonly Candle[] = [
  { o: 80, h: 84, l: 77, c: 78 },
  { o: 78, h: 80, l: 72, c: 73 },
  { o: 73, h: 76, l: 70, c: 75 },
  { o: 75, h: 76, l: 66, c: 67 },
  { o: 67, h: 69, l: 60, c: 61 },
  { o: 61, h: 64, l: 57, c: 63 },
  { o: 63, h: 64, l: 52, c: 53 },
  { o: 53, h: 56, l: 47, c: 49 },
  { o: 49, h: 51, l: 41, c: 43 },
  { o: 43, h: 46, l: 38, c: 40 },
  { o: 40, h: 45, l: 38, c: 44 },
  { o: 44, h: 50, l: 43, c: 49 },
  { o: 49, h: 53, l: 47, c: 52 },
  { o: 52, h: 56, l: 50, c: 55 },
];
const TOP_CANDLES: readonly Candle[] = [
  { o: 30, h: 33, l: 27, c: 32 },
  { o: 32, h: 37, l: 31, c: 36 },
  { o: 36, h: 38, l: 33, c: 34 },
  { o: 34, h: 42, l: 33, c: 41 },
  { o: 41, h: 46, l: 40, c: 45 },
  { o: 45, h: 50, l: 43, c: 49 },
  { o: 49, h: 58, l: 48, c: 56 },
  { o: 56, h: 58, l: 51, c: 53 },
  { o: 53, h: 62, l: 52, c: 61 },
  { o: 61, h: 67, l: 59, c: 66 },
  { o: 66, h: 70, l: 63, c: 64 },
  { o: 64, h: 73, l: 63, c: 72 },
  { o: 72, h: 80, l: 70, c: 79 },
  { o: 79, h: 82, l: 74, c: 76 },
];

function PerpsScene(): ReactElement {
  return (
    <Card title="ETH long" aside="2x isolated">
      <CandleChart
        candles={PERPS_CANDLES}
        lines={[
          { id: "tp", p: 82, kind: "striped", label: "Take profit" },
          { id: "entry", p: 36, kind: "plain", label: "Entry" },
          { id: "sl", p: 20, kind: "striped", label: "Stop loss" },
        ]}
        markers={[{ id: "long", at: 2, p: 36, label: "Long", line: "entry" }]}
      />
      <Row label="Size">
        <span className="tabular-nums">0.006 ETH</span>
      </Row>
    </Card>
  );
}

function DipScene(): ReactElement {
  return (
    <Card title="Buy the dip" aside="Holds 30 s">
      <CandleChart
        candles={DIP_CANDLES}
        lines={[
          { id: "high", p: 84, kind: "plain", label: "Recent high" },
          { id: "dip", p: 46, kind: "striped", label: "Dip price" },
        ]}
        markers={[{ id: "buy", at: 10, p: 44, label: "Buy", line: "dip" }]}
      />
      <Row label="Spend">
        <Tag>amount</Tag>
        <Tag>pay token</Tag>
      </Row>
    </Card>
  );
}

function TopScene(): ReactElement {
  return (
    <Card title="Profit targets" aside="Net profit">
      <CandleChart
        candles={TOP_CANDLES}
        lines={[
          { id: "second", p: 78, kind: "striped", label: "+30%" },
          { id: "first", p: 55, kind: "striped", label: "+15%" },
          { id: "cost", p: 30, kind: "plain", label: "Cost" },
        ]}
        markers={[
          { id: "sell-first", at: 6, p: 56, label: "Sell 25%", line: "first" },
          { id: "sell-second", at: 12, p: 79, label: "Sell 75%", line: "second" },
        ]}
      />
      <Row label="Tracks">
        <Tag>owned amount</Tag>
        <Tag>sell token</Tag>
      </Row>
    </Card>
  );
}

const SCENES: Readonly<Record<AgentPack, () => ReactElement>> = {
  private_payments: PaymentsScene,
  dca: DcaScene,
  spot_trader: SpotScene,
  perps: PerpsScene,
  meme_hunter: MemeHunt,
  buy_the_dip: DipScene,
  sell_the_top: TopScene,
};

/** The selected agent's scene, filling the stage. */
export function AgentScene({ pack }: { readonly pack: AgentPack }): ReactElement {
  const Scene = SCENES[pack];
  return (
    <div className="flex w-full flex-1 flex-col gap-3">
      <Scene />
    </div>
  );
}
