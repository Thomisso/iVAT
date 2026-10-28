import { getTranslations } from "next-intl/server";

export default async function DocumentsPage() {
  const t = await getTranslations("shell");
  return <main className="company-workspace"><header className="company-page-header"><h1>{t("documentsTitle")}</h1><p>{t("documentsDescription")}</p></header><section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("workspaceComing")}</p></section></main>;
}
