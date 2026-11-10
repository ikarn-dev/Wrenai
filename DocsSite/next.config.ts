import createMDX from "@next/mdx";
import type { NextConfig } from "next";

// Static export, like the landing page: no server, API calls or secrets. Security headers are set by the static
// host, since an export can't send them. Pages are MDX in content/, rendered at build time.
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  // An export has no image optimizer; the one raster image (the logo mark) is already cropped and small.
  images: { unoptimized: true },
};

// Plugins are named as strings so Turbopack can pass them to its MDX loader. remark-gfm adds tables, task lists
// and autolinks, which plain MDX lacks.
const withMDX = createMDX({ options: { remarkPlugins: [["remark-gfm", {}]] } });

export default withMDX(nextConfig);
