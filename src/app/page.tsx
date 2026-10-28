import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { selectCompanyAction } from "@/app/actions";
import { resolveCompanyContext } from "@/application/company-context";
import { companyContextCookie, parseCompanyContext } from "@/lib/company-context";
import { requireUserClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const client = await requireUserClient();
  const remembered = parseCompanyContext((await cookies()).get(companyContextCookie)?.value);
  const [context, t, app] = await Promise.all([
    resolveCompanyContext(client, remembered),
    getTranslations("shell"),
    getTranslations("app"),
  ]);
  if (context.kind === "company") redirect(`/companies/${context.companyId}`);

  return <main className="company-chooser-page">
    <section aria-labelledby="company-chooser-title" className="company-chooser-panel">
      <div className="company-chooser-brand" aria-hidden="true">{app("name")}</div>
      <h1 id="company-chooser-title">{t("chooseCompany")}</h1>
      <p>{context.companies.length ? t("chooseCompanyDescription") : t("noCompanies")}</p>
      {context.companies.length > 0 && <div className="company-chooser-list">{context.companies.map((company) => <form action={selectCompanyAction} key={company.id}>
        <input name="companyId" type="hidden" value={company.id} />
        <button type="submit"><span aria-hidden="true">{company.name.slice(0, 1)}</span><strong>{company.name}</strong><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg></button>
      </form>)}</div>}
      <Link className="company-chooser-add" href="/companies/new">{t("addCompany")}</Link>
    </section>
  </main>;
}
