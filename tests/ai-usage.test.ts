import { describe, expect, it } from "vitest";
import type { AiProvider, AiUsage } from "@/application/ai-provider";
import { listAiConfigurations, listAiModelPrices, setAiModelPrices } from "@/application/ai-configurations";
import { addAiUsageModelsFixture } from "./support/ai-usage";
import { listPlatformAiUsage, listPlatformAiUsageModels } from "@/application/ai-usage";
import { uploadSourceFile } from "@/application/source-files";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { aal2Client, promotedSuperAdministrator } from "./support/platform";
import { systemClient, testWorker } from "./support/worker";

const ALL_TIME = { from: "2000-01-01", to: "2100-01-01" };

/** A fake provider that splits `two-invoices.pdf` in two and reports the given usage. */
function meteredProvider(usage: { split: () => AiUsage; extract: () => AiUsage }): AiProvider {
  return {
    name: "fake",
    region: "local",
    async split() {
      return {
        model: "metered-split",
        documents: [
          { firstPage: 1, lastPage: 1 },
          { firstPage: 2, lastPage: 2 },
        ],
        usage: usage.split(),
      };
    },
    async extract() {
      return { model: "metered-extract", payload: SAMPLE_EXTRACTION, usage: usage.extract() };
    },
  };
}

/** An Organization Administrator whose Company processes through its own fake AI Configuration. */
async function meteredCompany(organizationName: string, provider: AiProvider) {
  const worker = testWorker(provider);
  const target = await administratorWithCompany(organizationName);
  await assignAiConfigurationFixture(target.client, worker.jobs, {
    companyId: target.companyId,
    provider: worker.ai,
  });
  const upload = async () => {
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runJobs();
  };
  return { ...target, upload };
}

async function configurationOf(client: Parameters<typeof listAiConfigurations>[0], companyId: string) {
  const configurations = await listAiConfigurations(client);
  if (!configurations.ok) throw new Error(configurations.error);
  const configuration = configurations.value.find((candidate) => candidate.assignedCompanyIds.includes(companyId));
  if (!configuration) throw new Error("The Company has no AI Configuration");
  const prices = await listAiModelPrices(client);
  if (!prices.ok) throw new Error(prices.error);
  const models = prices.value.find((candidate) => candidate.configurationId === configuration.id)?.models;
  return { ...configuration, models };
}

describe("platform AI usage metering", () => {
  it("includes every model group beyond the PostgREST row limit", async () => {
    const target = await meteredCompany("Many Usage Models", meteredProvider({
      split: () => ({ inputTokens: 1, outputTokens: 1 }),
      extract: () => ({ inputTokens: 1, outputTokens: 1 }),
    }));
    const superAdmin = await promotedSuperAdministrator("Complete Usage Analyst");
    const configuration = await configurationOf(superAdmin.client, target.companyId);
    await addAiUsageModelsFixture({ ...target, configurationId: configuration.id }, 1001);
    const usage = await listPlatformAiUsage(superAdmin.client, {
      ...ALL_TIME, companyId: target.companyId, groupBy: "model",
    });
    expect(usage.ok).toBe(true);
    if (!usage.ok) return;
    expect(usage.value).toHaveLength(1001);
    expect(usage.value.reduce((sum, group) => sum + group.requests, 0)).toBe(1001);
    expect(usage.value.reduce((sum, group) => sum + (group.costUsd ?? 0), 0)).toBe(1001);
    const models = await listPlatformAiUsageModels(superAdmin.client);
    expect(models.ok && models.value.includes("many-model-1000")).toBe(true);
  });

  it("summarizes usage across Organizations only for a SuperAdmin with MFA", async () => {
    const target = await meteredCompany("Visible to SuperAdmin", meteredProvider({
      split: () => ({ inputTokens: 10, outputTokens: 4 }),
      extract: () => ({ inputTokens: 20, outputTokens: 8 }),
    }));
    await target.upload();

    const promoted = await signedUpUser("Platform Usage");
    const promotion = await systemClient().from("platform_user").insert({
      user_id: promoted.userId,
      role: "super_admin",
    });
    if (promotion.error) throw promotion.error;

    const query = { ...ALL_TIME, groupBy: "model" as const, organizationId: target.organizationId };
    expect(await listPlatformAiUsage(target.client, query)).toEqual({ ok: false, error: "forbidden" });
    expect(await listPlatformAiUsage(promoted.client, query)).toEqual({ ok: false, error: "forbidden" });
    expect(await listPlatformAiUsage(aal2Client(promoted.userId), query)).toEqual({
      ok: true,
      value: [{
        key: "metered-extract",
        label: "metered-extract",
        requests: 2,
        inputTokens: 40,
        outputTokens: 16,
        costUsd: null,
        unknownCostEvents: 2,
      }, {
        key: "metered-split",
        label: "metered-split",
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
        costUsd: null,
        unknownCostEvents: 1,
      }],
    });
  });

  it("stores each call's cost at call time, preferring the provider-reported cost", async () => {
    const reported: { extractCostUsd?: number } = {};
    const target = await meteredCompany("Priced Usage", meteredProvider({
      split: () => ({ inputTokens: 1_000_000, outputTokens: 500_000 }),
      extract: () => ({
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        ...(reported.extractCostUsd === undefined ? {} : { costUsd: reported.extractCostUsd }),
      }),
    }));
    const superAdmin = await promotedSuperAdministrator("Pricing Platform");
    const configuration = await configurationOf(superAdmin.client, target.companyId);
    expect(configuration.models).toEqual([
      { model: "fake-extract", inputPricePerMillion: null, outputPricePerMillion: null },
      { model: "fake-split", inputPricePerMillion: null, outputPricePerMillion: null },
    ]);

    // No prices yet: every call has an unknown cost.
    await target.upload();

    expect(await setAiModelPrices(superAdmin.client, {
      configurationId: configuration.id,
      prices: [
        { model: "fake-split", inputPricePerMillion: 3, outputPricePerMillion: 15 },
        { model: "fake-extract", inputPricePerMillion: 1, outputPricePerMillion: 4 },
      ],
    })).toEqual({ ok: true, value: null });
    // Split costs 3 + 7.5 = 10.5 USD, each Extraction 2 + 4 = 6 USD.
    await target.upload();

    expect(await setAiModelPrices(superAdmin.client, {
      configurationId: configuration.id,
      prices: [{ model: "fake-split", inputPricePerMillion: 6, outputPricePerMillion: 30 }],
    })).toEqual({ ok: true, value: null });
    reported.extractCostUsd = 0.25;
    // Split now costs 21 USD; each Extraction costs what the provider reported.
    await target.upload();

    expect((await configurationOf(superAdmin.client, target.companyId)).models).toEqual([
      { model: "fake-extract", inputPricePerMillion: 1, outputPricePerMillion: 4 },
      { model: "fake-split", inputPricePerMillion: 6, outputPricePerMillion: 30 },
    ]);
    expect(await listPlatformAiUsage(superAdmin.client, {
      ...ALL_TIME,
      companyId: target.companyId,
      groupBy: "operation",
    })).toEqual({
      ok: true,
      value: [{
        key: "extract",
        label: "extract",
        requests: 6,
        inputTokens: 12_000_000,
        outputTokens: 6_000_000,
        costUsd: 12.5,
        unknownCostEvents: 2,
      }, {
        key: "split",
        label: "split",
        requests: 3,
        inputTokens: 3_000_000,
        outputTokens: 1_500_000,
        costUsd: 31.5,
        unknownCostEvents: 1,
      }],
    });
  });

  it("filters platform usage and sums it by the chosen dimension", async () => {
    const usage = {
      split: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      extract: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    };
    const first = await meteredCompany("First Usage Organization", meteredProvider(usage));
    const second = await meteredCompany("Second Usage Organization", meteredProvider(usage));
    const superAdmin = await promotedSuperAdministrator("Usage Analyst");
    const firstConfiguration = await configurationOf(superAdmin.client, first.companyId);
    const secondConfiguration = await configurationOf(superAdmin.client, second.companyId);
    await setAiModelPrices(superAdmin.client, {
      configurationId: firstConfiguration.id,
      prices: [{ model: "fake-extract", inputPricePerMillion: 1, outputPricePerMillion: 2 }],
    });
    await first.upload();
    await second.upload();
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());

    expect(await listPlatformAiUsage(superAdmin.client, {
      ...ALL_TIME,
      organizationId: first.organizationId,
      groupBy: "ai_configuration",
    })).toEqual({
      ok: true,
      value: [{
        key: firstConfiguration.id,
        label: firstConfiguration.label,
        requests: 3,
        inputTokens: 3_000_000,
        outputTokens: 3_000_000,
        costUsd: 6,
        unknownCostEvents: 1,
      }],
    });
    expect(await listPlatformAiUsage(superAdmin.client, {
      ...ALL_TIME,
      configurationId: secondConfiguration.id,
      operation: "split",
      groupBy: "company",
    })).toEqual({
      ok: true,
      value: [{
        key: second.companyId,
        label: "Second Usage Organization · Novák s.r.o.",
        requests: 1,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: null,
        unknownCostEvents: 1,
      }],
    });
    expect(await listPlatformAiUsage(superAdmin.client, {
      from: today,
      to: today,
      companyId: first.companyId,
      model: "metered-extract",
      groupBy: "month",
    })).toEqual({
      ok: true,
      value: [{
        key: today.slice(0, 7),
        label: today.slice(0, 7),
        requests: 2,
        inputTokens: 2_000_000,
        outputTokens: 2_000_000,
        costUsd: 6,
        unknownCostEvents: 0,
      }],
    });
    expect(await listPlatformAiUsage(superAdmin.client, {
      from: "2000-01-01",
      to: "2000-12-31",
      companyId: first.companyId,
      groupBy: "organization",
    })).toEqual({ ok: true, value: [] });
  });

  it("lets only a SuperAdmin set model prices", async () => {
    const target = await meteredCompany("Price Outsider", meteredProvider({
      split: () => ({ inputTokens: 1, outputTokens: 1 }),
      extract: () => ({ inputTokens: 1, outputTokens: 1 }),
    }));
    const superAdmin = await promotedSuperAdministrator("Price Owner");
    const configuration = await configurationOf(superAdmin.client, target.companyId);

    expect(await listAiModelPrices(target.client)).toEqual({ ok: false, error: "forbidden" });
    expect(await setAiModelPrices(target.client, {
      configurationId: configuration.id,
      prices: [{ model: "fake-split", inputPricePerMillion: 1, outputPricePerMillion: 1 }],
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await setAiModelPrices(superAdmin.client, {
      configurationId: configuration.id,
      prices: [{ model: "fake-split", inputPricePerMillion: -1, outputPricePerMillion: 1 }],
    })).toEqual({ ok: false, error: "invalid_price" });
    expect(await setAiModelPrices(superAdmin.client, {
      configurationId: configuration.id,
      prices: [{ model: "not-in-configuration", inputPricePerMillion: 1, outputPricePerMillion: 1 }],
    })).toEqual({ ok: false, error: "unknown_model" });
    expect((await configurationOf(superAdmin.client, target.companyId)).models).toEqual([
      { model: "fake-extract", inputPricePerMillion: null, outputPricePerMillion: null },
      { model: "fake-split", inputPricePerMillion: null, outputPricePerMillion: null },
    ]);
  });
});
