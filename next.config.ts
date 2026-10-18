import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // task78b: editing this file triggers next dev's built-in config-change
  // restart, which reloads server code and reopens db/custom.db at its current
  // inode (fixes prisma 1032 "attempt to write a readonly database" caused by
  // the platform snapshot replacing the db file while next-server held the
  // deleted inode). See worklog Task 78-b.
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
