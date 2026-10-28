import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { UPLOAD_BODY_LIMIT } from "./src/lib/upload-policy";

// Source Files are uploaded through a Server Action and pass the proxy. The
// configurable database limit cannot exceed the Storage service's static limit;
// this adds room for multipart overhead so every accepted setting is transportable.

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
