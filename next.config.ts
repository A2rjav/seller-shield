import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (local dev database fallback) loads its own wasm/data files at runtime; keep it out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
