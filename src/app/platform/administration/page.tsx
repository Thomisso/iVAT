import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  retryFailedProcessingJobAction,
  setPlatformOrganizationBlockedAction,
} from "@/app/actions";
import {
  getPlatformUploadLimits,
  listPlatformOrganizationCompanies,
} from "@/application/platform-administration";
import { listFailedProcessingJobs } from "@/application/processing-administration";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandButton } from "@/components/command-button";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { requireUserClient } from "@/lib/supabase/server";
import { UploadLimitsForm } from "./upload-limits-form";

export default async function PlatformAdministrationPage() {
  const client = await requireUserClient();
  const organizations = await listPlatformOrganizationCompanies(client);
  if (!organizations.ok) notFound();
  const [limits, jobs, t] = await Promise.all([
    getPlatformUploadLimits(client),
    listFailedProcessingJobs(client),
    getTranslations("platformAdministration"),
  ]);
  if (!limits.ok || !jobs.ok) notFound();

  return (
    <>
      <AppSidebar />
      <main className="dashboard">
        <header>
          <h1>{t("title")}</h1>
          <p className="iv-muted">{t("intro")}</p>
        </header>

        <section className="panel">
          <h2>{t("organizations")}</h2>
          <DataTable
            caption={t("organizations")}
            rows={organizations.value.map((organization) => ({
              ...organization,
              companyNames: organization.companies.map((company) => `${company.name} · IČO ${company.ico}`).join(", "),
            }))}
            columns={[
              { key: "name", header: t("organization") },
              { key: "companyNames", header: t("companies") },
              {
                key: "blocked",
                header: t("status"),
                render: (organization) => organization.blocked
                  ? <StatusBadge status="failed">{t("blocked")}</StatusBadge>
                  : <StatusBadge status="approved">{t("active")}</StatusBadge>,
              },
              {
                key: "action",
                header: t("action"),
                render: (organization) => (
                  <CommandButton
                    action={setPlatformOrganizationBlockedAction}
                    fields={{ organizationId: organization.id, blocked: String(!organization.blocked) }}
                    variant={organization.blocked ? "secondary" : "danger"}
                    size="sm"
                  >
                    {organization.blocked ? t("unblock") : t("block")}
                  </CommandButton>
                ),
              },
            ]}
          />
        </section>

        <section className="panel">
          <h2>{t("failedJobs")}</h2>
          <p className="iv-muted">{t("failedJobsIntro")}</p>
          {jobs.value.length === 0 ? <p>{t("noFailedJobs")}</p> : (
            <DataTable
              caption={t("failedJobs")}
              rows={jobs.value}
              columns={[
                { key: "name", header: t("job") },
                { key: "targetId", header: t("target"), mono: true },
                { key: "failedAt", header: t("failedAt") },
                { key: "error", header: t("failure") },
                {
                  key: "action",
                  header: t("action"),
                  render: (job) => (
                    <CommandButton
                      action={retryFailedProcessingJobAction}
                      fields={{ jobId: job.id }}
                      size="sm"
                    >
                      {t("retry")}
                    </CommandButton>
                  ),
                },
              ]}
            />
          )}
        </section>

        <section className="panel">
          <h2>{t("uploadLimits")}</h2>
          <p className="iv-muted">{t("uploadLimitsIntro")}</p>
          <UploadLimitsForm limits={limits.value} />
        </section>
      </main>
    </>
  );
}
