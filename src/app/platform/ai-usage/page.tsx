import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listPlatformAiUsage } from "@/application/ai-usage";
import { AiUsageTable } from "@/components/ai-usage-table";
import { Button } from "@/components/button";
import { requireUserClient } from "@/lib/supabase/server";
import { DateInput } from "@/components/date-input";

function currentMonth() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function date(value: string | string[] | undefined, fallback: string) {
  const candidate = typeof value === "string" ? value : "";
  return /^20\d{2}-\d{2}-\d{2}$/.test(candidate) ? candidate : fallback;
}

export default async function PlatformAiUsagePage({ searchParams }: PageProps<"/platform/ai-usage">) {
  const query = await searchParams;
  const defaults = currentMonth();
  const from = date(query.from, defaults.from);
  const to = date(query.to, defaults.to);
  const [usage, t] = await Promise.all([
    listPlatformAiUsage(await requireUserClient(), { from, to }),
    getTranslations("aiUsage"),
  ]);
  if (!usage.ok) notFound();

  return (
    <>
      <main className="dashboard platform-page">
        <header>
          <h1>{t("platformTitle")}</h1>
          <p className="iv-muted">{t("platformIntro")}</p>
        </header>
        <form className="form filters" method="get" aria-label={t("filters") }>
          <DateInput label={t("from")} name="from" defaultValue={from} />
          <DateInput label={t("to")} name="to" defaultValue={to} />
          <Button type="submit">{t("filter")}</Button>
        </form>
        <AiUsageTable
          rows={usage.value.map((row) => ({
            id: `${row.organizationId}:${row.provider}:${row.model}`,
            owner: row.organizationName,
            provider: row.provider,
            model: row.model,
            requests: row.requests,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          }))}
          labels={{
            caption: t("platformTitle"),
            owner: t("organization"),
            provider: t("provider"),
            model: t("model"),
            requests: t("requests"),
            inputTokens: t("inputTokens"),
            outputTokens: t("outputTokens"),
            empty: t("empty"),
          }}
        />
      </main>
    </>
  );
}
