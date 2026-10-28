import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";
import type { AiProvider } from "@/application/ai-provider";
import { listOrganizationAiUsage, listPlatformAiUsage } from "@/application/ai-usage";
import { asUserClient } from "@/application/client";
import { createCompany, enableAiProcessing } from "@/application/companies";
import { uploadSourceFile } from "@/application/source-files";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";
import { systemClient, testWorker } from "./support/worker";

function aal2Client(userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: "authenticated",
    aal: "aal2",
    session_id: `usage-test-${userId}`,
  })}`;
  const signature = createHmac("sha256", inject("supabaseJwtSecret")).update(unsigned).digest("base64url");
  return asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    accessToken: async () => `${unsigned}.${signature}`,
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

const meteredProvider: AiProvider = {
  name: "fake",
  region: "local",
  async split() {
    return {
      model: "metered-split",
      documents: [
        { firstPage: 1, lastPage: 1 },
        { firstPage: 2, lastPage: 2 },
      ],
      usage: { inputTokens: 10, outputTokens: 4 },
    };
  },
  async extract() {
    return {
      model: "metered-extract",
      payload: SAMPLE_EXTRACTION,
      usage: { inputTokens: 20, outputTokens: 8 },
    };
  },
};

describe("AI usage metering", () => {
  it("records every Split and Extract call and summarizes it for the Organization Administrator", async () => {
    const worker = testWorker(meteredProvider);
    const admin = await administratorWithCompany("Metered Organization");
    expect(await enableAiProcessing(admin.client, worker.jobs, {
      companyId: admin.companyId,
      provider: worker.ai,
    })).toEqual({ ok: true, value: null });
    const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
      companyId: admin.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);

    expect(await listOrganizationAiUsage(admin.client, {
      organizationId: admin.organizationId,
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual({
      ok: true,
      value: [
        {
          companyId: admin.companyId,
          companyName: "Novák s.r.o.",
          provider: "fake",
          model: "metered-extract",
          requests: 2,
          inputTokens: 40,
          outputTokens: 16,
        },
        {
          companyId: admin.companyId,
          companyName: "Novák s.r.o.",
          provider: "fake",
          model: "metered-split",
          requests: 1,
          inputTokens: 10,
          outputTokens: 4,
        },
      ],
    });
  });

  it("does not expose an Organization's usage to another Organization", async () => {
    const worker = testWorker(meteredProvider);
    const owner = await administratorWithCompany("Usage Owner");
    const outsider = await signedUpUser("Usage Outsider");
    await enableAiProcessing(owner.client, worker.jobs, {
      companyId: owner.companyId,
      provider: worker.ai,
    });
    const uploaded = await uploadSourceFile(owner.client, worker.jobs, {
      companyId: owner.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runJobs();

    expect(await listOrganizationAiUsage(outsider.client, {
      organizationId: owner.organizationId,
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual({ ok: false, error: "forbidden" });
    const direct = await outsider.client.from("ai_usage_event").select("id");
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual([]);
  });

  it("summarizes usage across Organizations only for a SuperAdmin with MFA", async () => {
    const worker = testWorker(meteredProvider);
    const target = await administratorWithCompany("Visible to SuperAdmin");
    await enableAiProcessing(target.client, worker.jobs, {
      companyId: target.companyId,
      provider: worker.ai,
    });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runJobs();

    const promoted = await signedUpUser("Platform Usage");
    const promotion = await systemClient().from("platform_user").insert({
      user_id: promoted.userId,
      role: "super_admin",
    });
    if (promotion.error) throw promotion.error;

    expect(await listPlatformAiUsage(target.client, {
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await listPlatformAiUsage(promoted.client, {
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await listPlatformAiUsage(aal2Client(promoted.userId), {
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual(expect.objectContaining({
      ok: true,
      value: expect.arrayContaining([{
        organizationId: target.organizationId,
        organizationName: "Visible to SuperAdmin",
        provider: "fake",
        model: "metered-extract",
        requests: 2,
        inputTokens: 40,
        outputTokens: 16,
      }, {
        organizationId: target.organizationId,
        organizationName: "Visible to SuperAdmin",
        provider: "fake",
        model: "metered-split",
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
      }]),
    }));
  });

  it("filters an Organization's usage by Company and date range", async () => {
    const admin = await administratorWithCompany("Filtered Usage");
    const second = await createCompany(admin.client, {
      organizationId: admin.organizationId,
      ...companyDetails({ name: "Second Company" }),
    });
    if (!second.ok) throw new Error(second.error);
    for (const [companyId, model, tokens] of [
      [admin.companyId, "first-model", 5],
      [second.value.id, "second-model", 7],
    ] as const) {
      const recorded = await systemClient().rpc("record_ai_usage", {
        target_organization_id: admin.organizationId,
        target_company_id: companyId,
        target_provider: "fake",
        target_model: model,
        target_operation: "extract",
        target_input_tokens: tokens,
        target_output_tokens: 1,
        target_job_name: "extract-document",
        target_job_id: crypto.randomUUID(),
      });
      if (recorded.error) throw recorded.error;
    }

    expect(await listOrganizationAiUsage(admin.client, {
      organizationId: admin.organizationId,
      companyId: second.value.id,
      from: "2000-01-01",
      to: "2100-01-01",
    })).toEqual({
      ok: true,
      value: [{
        companyId: second.value.id,
        companyName: "Second Company",
        provider: "fake",
        model: "second-model",
        requests: 1,
        inputTokens: 7,
        outputTokens: 1,
      }],
    });
    expect(await listOrganizationAiUsage(admin.client, {
      organizationId: admin.organizationId,
      from: "2099-01-01",
      to: "2100-01-01",
    })).toEqual({ ok: true, value: [] });
  });
});
