import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Source Files of up to 20 MB are uploaded through a Server Action (and pass the
// proxy), so both request bodies must fit one, plus the multipart overhead.
const UPLOAD_BODY_LIMIT = "21mb";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: UPLOAD_BODY_LIMIT },
    proxyClientMaxBodySize: UPLOAD_BODY_LIMIT,
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
