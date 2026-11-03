import type { NextConfig } from "next";

// Static export (Docs/tech-stack.md → Repo layout): no server, API calls or secrets. Security headers are set by
// the static host, since an export can't send them.
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // An export has no image optimizer; the one raster image (the logo mark) is already cropped and small.
  images: { unoptimized: true },
};

export default nextConfig;
