import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // repo root: lets the app import design/ (tokens, motion) and read the official CSVs next to it
  turbopack: { root: path.join(__dirname, "..") },
};

export default nextConfig;
