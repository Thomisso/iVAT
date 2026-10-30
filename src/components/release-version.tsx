"use client";

import { useTranslations } from "next-intl";
import { releaseIdentity } from "@/lib/release-identity";

export function ReleaseVersion() {
  const t = useTranslations("release");
  return <p className="release-version" title={releaseIdentity ? t("revision", { revision: releaseIdentity.revision }) : undefined}>
    {releaseIdentity ? t("version", { version: releaseIdentity.tag }) : t("development")}
  </p>;
}
