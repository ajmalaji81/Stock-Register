import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  // Let phones / other PCs on the local network use the dev server (e.g. http://192.168.1.2:3000).
  // Without this, Next.js blocks dev-only scripts for non-localhost origins and pages don't become interactive.
  // Development only; has no effect on production builds.
  allowedDevOrigins: ["192.168.1.2", "192.168.*.*", "10.*.*.*"],
};

export default nextConfig;
