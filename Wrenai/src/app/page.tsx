import { redirect } from "next/navigation";
import { Brand } from "@/components/shell/brand";
import { LiveHalftone } from "@/components/texture/live-halftone";
import { SignInPanel } from "@/components/wallet/sign-in-panel";
import { currentUser } from "@/server/auth/session";
import { signInFont } from "./fonts";

// Decorative pane: glow and live halftone stay inside it, so nothing sits under text.
function SignInVisual() {
  return (
    <div
      aria-hidden="true"
      className="relative order-first h-36 overflow-hidden rounded-inset bg-sunken sm:h-44 lg:order-none lg:h-auto"
    >
      <div className="absolute inset-0 glow-pane motion-safe:animate-glow-breathe" />
      <LiveHalftone className="absolute inset-0 text-texture-hero fade-radial-end" />
    </div>
  );
}

// Backdrop light at the bottom edge and, mirrored, the top edge. It sits behind everything (-z-10 inside the
// isolated main), and the card is opaque, so the light never shows through or over it.
function PageGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-x-0 top-0 h-1/4 -scale-y-100 glow-page" />
      <div className="absolute inset-x-0 bottom-0 h-1/4 glow-page" />
    </div>
  );
}

export default async function SignInPage() {
  if ((await currentUser()) !== null) {
    redirect("/portfolio");
  }
  return (
    <main className="relative isolate grid min-h-dvh place-items-center overflow-hidden px-gutter py-8">
      <PageGlow />
      <div className="relative grid w-full max-w-4xl gap-2 card-shine rounded-xl p-2 lg:min-h-120 lg:grid-cols-2">
        <section
          aria-labelledby="sign-in-heading"
          className={`${signInFont.className} flex flex-col items-center px-5 py-6 text-center sm:px-8 lg:py-8`}
        >
          <div className="flex w-full max-w-sm flex-1 flex-col justify-center py-4">
            <p className="mb-6 flex justify-center">
              <Brand size="lg" />
            </p>
            <h1 id="sign-in-heading" className="text-sign-in-title text-fg-strong">
              {/* Split for color only, like the wordmark; screen readers get "DeFi" as one word. */}
              <span aria-hidden="true">
                Private AI for your De<span className="text-accent-text">Fi</span>
              </span>
              <span className="sr-only">Private AI for your DeFi</span>
            </h1>
            <p className="mt-1 text-small text-fg-muted">Connect a NEAR wallet to get started</p>
            <div className="mt-4">
              <SignInPanel />
            </div>
          </div>
          <p className="text-small text-fg-subtle">Private AI agents for DeFi on NEAR</p>
        </section>
        <SignInVisual />
      </div>
    </main>
  );
}
