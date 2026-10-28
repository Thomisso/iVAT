import { getTranslations } from "next-intl/server";

export default async function VatPage() {
  const t = await getTranslations("shell");
  return <main className="company-workspace"><header className="company-page-header"><h1>{t("vatTitle")}</h1><p>{t("vatDescription")}</p></header><section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("workspaceComing")}</p></section></main>;
}
