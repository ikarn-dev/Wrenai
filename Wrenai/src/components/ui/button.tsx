import { LoaderCircle } from "lucide-react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

type RaisedVariant = "primary" | "soft" | "danger";
type FlatVariant = "secondary" | "ghost" | "destructive";
type ButtonVariant = RaisedVariant | FlatVariant;
type ButtonSize = "md" | "lg";

// Docs/DESIGN.md → Components → Buttons. Hover styles apply only on hover-capable devices (Tailwind v4 default).
// Tailwind v4 resets buttons to the default cursor, so the pointer is set here.
// Heights are fixed, so labels never wrap; a label that may not fit truncates in its own span.
const SHARED =
  "cursor-pointer whitespace-nowrap rounded-sm font-medium disabled:cursor-not-allowed aria-busy:cursor-default";

// The row that holds the icon and label: a flat button itself, or a raised button's face. Relative, so the busy
// spinner can sit over the hidden label.
const ROW = "relative items-center justify-center gap-2";

const SIZES: Readonly<Record<ButtonSize, { readonly box: string; readonly text: string }>> = {
  md: { box: "h-10 px-4 pointer-coarse:h-11", text: "text-body" },
  // Page-level calls to action, such as sign-in.
  lg: { box: "h-12 px-5", text: "text-lead" },
};

const SOFT_TRANSITION = "transition-colors duration-300 ease-ios";

const FLAT_VARIANTS: Readonly<Record<FlatVariant, string>> = {
  secondary: `${SOFT_TRANSITION} border border-line bg-surface-2 text-fg-strong hover:border-line-strong disabled:text-fg-disabled`,
  ghost: `${SOFT_TRANSITION} text-fg hover:bg-surface-2 hover:text-fg-strong disabled:text-fg-disabled`,
  destructive: `${SOFT_TRANSITION} border border-loss text-loss hover:bg-loss-soft disabled:border-line disabled:text-fg-disabled`,
};

// A raised button is a face on a darker lip (button-raised and button-face in globals.css); the variant utility
// colors it. The element stacks the face over the lip's space; the face holds the label row and the size's height
// and padding. Both raised variants share the lip and press, so side by side they match in height and motion.
const RAISED_VARIANTS: Readonly<Record<RaisedVariant, string>> = {
  primary: "button-glow text-accent-fg",
  // The quiet action beside a primary (Later): same shape and press, no glow.
  soft: "button-soft text-fg-strong",
  // The destructive confirm beside a soft Cancel, so both share one height and press.
  danger: "button-danger text-loss",
};

function isRaised(variant: ButtonVariant): variant is RaisedVariant {
  return variant === "primary" || variant === "soft" || variant === "danger";
}

function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const { box, text } = SIZES[size];
  return isRaised(variant)
    ? `button-raised inline-flex flex-col disabled:text-fg-disabled ${RAISED_VARIANTS[variant]} ${SHARED} ${text}`
    : `inline-flex ${ROW} ${SHARED} ${box} ${text} ${FLAT_VARIANTS[variant]}`;
}

interface ButtonFaceProps {
  readonly size: ButtonSize;
  readonly children: ReactNode;
}

/** The raised face, which sinks into the lip on press. */
function ButtonFace({ size, children }: ButtonFaceProps) {
  return <span className={`button-face flex ${ROW} ${SIZES[size].box}`}>{children}</span>;
}

/**
 * While busy the label keeps its space but hides, and a spinner takes its place, so the button never changes width.
 * The label stays in the accessibility tree through the sr-only copy.
 */
function BusyContent({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="invisible inline-flex items-center gap-2">
        {children}
      </span>
      <span className="sr-only">{children}</span>
      <LoaderCircle
        aria-hidden="true"
        size={18}
        strokeWidth={1.75}
        absoluteStrokeWidth
        className="absolute motion-safe:animate-spin"
      />
    </>
  );
}

function ignoreBusyClick(event: MouseEvent<HTMLButtonElement>): void {
  // Also stops a submit button from submitting its form a second time.
  event.preventDefault();
}

interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "className" | "type"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly type?: "button" | "submit";
  /** Shows a spinner in place of the label and ignores clicks until the work finishes. */
  readonly busy?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  busy = false,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const content = busy ? <BusyContent>{children}</BusyContent> : children;
  return (
    <button
      type={type}
      className={buttonClasses(variant, size)}
      {...props}
      {...(busy ? { "aria-busy": true, onClick: ignoreBusyClick } : onClick ? { onClick } : {})}
    >
      {isRaised(variant) ? <ButtonFace size={size}>{content}</ButtonFace> : content}
    </button>
  );
}
