import buildIdentity from "./build-identity.json";

/** Written by the verified image build, compiled into web bundles and copied
 * with runtime source. Never inferred from runtime environment or package.json. */
export const releaseIdentity = buildIdentity as { tag: string; revision: string } | null;

export const xmlGeneratorVersion = releaseIdentity
  ? `${releaseIdentity.tag}+${releaseIdentity.revision}`
  : "development";
