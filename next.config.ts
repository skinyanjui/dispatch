import type { NextConfig } from "next";
const config: NextConfig = {
  experimental: { cpus: 2 },
  poweredByHeader: false,
};
export default config;
