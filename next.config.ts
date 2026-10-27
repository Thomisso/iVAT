import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Source Files are uploaded through a Server Action and pass the proxy, so both
// must accept a file of the platform's 20 MB upload limit (enforced with #33),
// plus the multipart overhead. Their 1 MB and 10 MB defaults would cut uploads off.
const UPLOAD_BODY_LIMIT = "21mb";

const nextConfig: NextConfig = {
  // Keep the validator's WASM module beside its Node entry point.
  serverExternalPackages: ["libxml2-wasm"],
  outputFileTracingIncludes: {
    "/companies/**/vat-reports/**/xml": [
      "./schemas/epo/*.xsd",
      "./node_modules/libxml2-wasm/lib/*.wasm",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: UPLOAD_BODY_LIMIT },
    proxyClientMaxBodySize: UPLOAD_BODY_LIMIT,
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
