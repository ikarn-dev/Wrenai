import { redirect } from "next/navigation";
import { Brand } from "@/components/shell/brand";
import { LogoMorph } from "@/components/texture/logo-morph";
import { SignInPanel } from "@/components/wallet/sign-in-panel";
import { currentUser } from "@/server/auth/session";
import { signInFont } from "./fonts";

// Decorative pane: a dark well where the logo morph runs, so nothing sits under text. No glow.
function SignInVisual() {
  return (
    <div
      aria-hidden="true"
      className="relative order-first h-36 overflow-hidden rounded-inset bg-sunken sm:h-44 lg:order-none lg:h-auto"
    >
      <LogoMorph className="absolute inset-0 text-texture-hero" />
    </div>
  );
}

export default async function SignInPage() {
  if ((await currentUser()) !== null) {
    redirect("/portfolio");
  }
  return (
    <main className="grid min-h-dvh place-items-center px-gutter py-8">
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
