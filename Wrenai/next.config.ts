import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // USB, HID and clipboard stay allowed: hardware and sandboxed wallets in NEAR Connect use them.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Wallet sign-in opens popups that must keep a reference to this window.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Dev only: bottom-left covered the sidebar's last item (Settings and Documentation are pinned there).
  devIndicators: { position: "bottom-right" },
  typedRoutes: true,
  serverExternalPackages: ["@nearai/inference-sdk"],
  // Token icons: Spot from CoinGecko's market data (src/server/manual-trading/token-metrics.ts).
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "coin-images.coingecko.com", pathname: "/coins/images/**", search: "" },
      // Memecoin icons Squint links to (src/server/manual-trading/memecoins.ts).
      { protocol: "https", hostname: "nearly.trade", pathname: "/api/img/**", search: "" },
      { protocol: "https", hostname: "cdn.dexscreener.com", pathname: "/cms/images/**", search: "" },
    ],
  },
  // pg reads the CA named by sslrootcert at runtime; trace it into deployed Node functions.
  outputFileTracingIncludes: { "/*": ["./certs/supabase-root-2021.crt"] },
  redirects() {
    return Promise.resolve([
      { source: "/favicon.ico", destination: "/assets/nobg_logo.png", permanent: true },
    ]);
  },
  headers() {
    return Promise.resolve([
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/recovery-tool.html",
        headers: [
          { key: "Content-Disposition", value: 'attachment; filename="wrenai-offline-recovery.html"' },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]);
  },
};

export default withWorkflow(nextConfig);
