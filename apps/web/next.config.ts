import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // share tokens live in URLs: never leak them via Referer
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // server-only workspace packages and native/wasm deps run as plain Node modules
  serverExternalPackages: ["@dentosim/server", "@dentosim/pipeline", "@dentosim/canonical", "pg", "bullmq", "ioredis", "stripe", "@sentry/node", "@node-rs/argon2"],
  transpilePackages: ["@dentosim/viewer-core"],
  async headers() {
    return [
      { source: "/:path*", headers: [...securityHeaders, { key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] },
      // patient pages and ?embed=1 viewers may be framed by clinic websites
      { source: "/setup/:path*", headers: [...securityHeaders, { key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
};

export default config;
