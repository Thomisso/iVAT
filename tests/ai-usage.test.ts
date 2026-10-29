import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";
import type { AiProvider } from "@/application/ai-provider";
import { listPlatformAiUsage } from "@/application/ai-usage";
import { asUserClient } from "@/application/client";
import { uploadSourceFile } from "@/application/source-files";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
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

describe("platform AI usage metering", () => {
  it("summarizes usage across Organizations only for a SuperAdmin with MFA", async () => {
    const worker = testWorker(meteredProvider);
    const target = await administratorWithCompany("Visible to SuperAdmin");
    await assignAiConfigurationFixture(target.client, worker.jobs, {
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
});
