import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

// NEAR Connect runs wallet code in a srcdoc iframe, which inherits this policy, so the policy has to fit the wallets
// too (manifest scanned Oct 26, 2026):
// - most wallet bundles contain eval or new Function and several instantiate WebAssembly, so script-src allows both;
//   injected <script> tags and inline handlers stay blocked because scripts need the nonce
// - NEAR Connect and the wallets inject <style> without a nonce, so style-src allows inline styles
// - wallets call their own APIs, RPCs and WalletConnect relays, frame their own pages and load icons from many hosts
// No upgrade-insecure-requests: every subresource is same-origin or already https, and on a plain-http local run
// it would rewrite the app's own requests to https and break them. HSTS (next.config.ts) covers the live site.
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Sets a per-request nonce CSP. Next reads the nonce from the request header and puts it on its own scripts
 * (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 */
export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy(randomBytes(16).toString("base64"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

// Documents only: static files, optimized images, public assets and link prefetches don't need a policy.
export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|assets/|favicon.ico|.well-known/workflow/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
