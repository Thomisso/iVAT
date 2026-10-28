import { getTranslations } from "next-intl/server";

export default async function UploadPage() {
  const t = await getTranslations("shell");
  return <main className="company-workspace"><header className="company-page-header"><h1>{t("uploadTitle")}</h1><p>{t("uploadDescription")}</p></header><section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("workspaceComing")}</p></section></main>;
}
