import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json in a parent directory otherwise makes Turbopack
  // guess the wrong workspace root.
  turbopack: { root: __dirname },
};

export default nextConfig;
