import Image from "next/image";
import logo from "../../../public/assets/nobg_logo.png";

type BrandSize = "md" | "lg";

// lg: the sign-in card. md: the app's sidebar and mobile header.
const SIZES: Readonly<Record<BrandSize, { readonly mark: number; readonly row: string }>> = {
  md: { mark: 28, row: "gap-1 text-h2" },
  lg: { mark: 42, row: "gap-1.5 text-h1" },
};

interface BrandProps {
  readonly size: BrandSize;
  /** Fades the wordmark out, leaving the mark (the collapsed sidebar). Screen readers still get the name. */
  readonly markOnly?: boolean;
}

/** The logo mark and the "Wrenai" wordmark, with "ai" in the accent color. Docs/DESIGN.md → Typography. */
export function Brand({ size, markOnly = false }: BrandProps) {
  const { mark, row } = SIZES[size];
  return (
    <span className={`relative inline-flex items-center text-fg-strong ${row}`}>
      {/* The name sits beside the mark, so the image adds nothing for screen readers.
          The file is cropped to the mark's edges, so the gap is set here, not by empty pixels. */}
      <Image src={logo} alt="" height={mark} loading="eager" className="shrink-0" />
      {/* Split for color only; screen readers get the name as one word.
          The rounded face is drawn light: its 700 reads as a semibold, so it is the one face set above 600. */}
      <span
        aria-hidden="true"
        // Fades only and stays in place, so a width animation around it never moves the mark.
        className={`font-rounded font-bold whitespace-nowrap transition-opacity duration-300 ease-ios motion-reduce:transition-none ${markOnly ? "opacity-0" : "opacity-100"}`}
      >
        Wren<span className="text-accent-text">ai</span>
      </span>
      <span className="sr-only">Wrenai</span>
    </span>
  );
}
