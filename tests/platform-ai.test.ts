import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { asUserClient } from "@/application/client";
import { enableAiProcessing, listCompanyAiOptions } from "@/application/companies";
import {
  configurePlatformAiProvider,
  listAvailableAiProviders,
  listPlatformAiProviders,
  listPlatformOrganizations,
  resolvePlatformAiProvider,
  setOrganizationPlatformAiAccess,
} from "@/application/platform-ai";
import { getSourceFile, uploadSourceFile } from "@/application/source-files";
import { platformAnthropicAiProvider } from "@/ai/anthropic";
import { fixtureFile } from "./support/files";
import { administratorWithCompany } from "./support/fixtures";
import { signedUpUser } from "./support/clients";
import { systemClient, testWorker } from "./support/worker";

async function superAdmin() {
  const user = await signedUpUser("Platform Administration");
  const { error } = await systemClient().from("platform_user").insert({
    user_id: user.userId,
    role: "super_admin",
  });
  if (error) throw error;
  return { ...user, client: aal2Client(user.userId) };
}

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
    session_id: `platform-test-${userId}`,
  })}`;
  const signature = createHmac("sha256", inject("supabaseJwtSecret")).update(unsigned).digest("base64url");
  return asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    accessToken: async () => `${unsigned}.${signature}`,
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

let sharedSuperAdministrator: Awaited<ReturnType<typeof superAdmin>>;

beforeAll(async () => {
  sharedSuperAdministrator = await superAdmin();
});

describe("platform AI provider settings", () => {
  it("lets only a SuperAdmin store a platform key and never returns the key", async () => {
    const ordinaryAdministrator = await signedUpUser("Ordinary Organization");
    const unsatisfiedSuperAdministrator = await signedUpUser("SuperAdmin without MFA");
    const promoted = await systemClient().from("platform_user").insert({
      user_id: unsatisfiedSuperAdministrator.userId,
      role: "super_admin",
    });
    if (promoted.error) throw promoted.error;
    const superAdministrator = sharedSuperAdministrator;
    const settings = {
      provider: "anthropic",
      available: true,
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      apiKey: "sk-ant-platform-secret",
    } as const;

    expect(await configurePlatformAiProvider(ordinaryAdministrator.client, settings)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await configurePlatformAiProvider(unsatisfiedSuperAdministrator.client, settings)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listPlatformAiProviders(ordinaryAdministrator.client)).toEqual({
      ok: false,
      error: "forbidden",
    });

    expect(await configurePlatformAiProvider(superAdministrator.client, {
      provider: "openai",
      available: true,
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      apiKey: "sk-openai-platform-secret",
    })).toEqual({ ok: true, value: null });
    expect(await listAvailableAiProviders(ordinaryAdministrator.client)).toEqual(
      expect.arrayContaining([{ provider: "openai", region: "global" }]),
    );

    expect(await configurePlatformAiProvider(superAdministrator.client, settings)).toEqual({ ok: true, value: null });
    expect(await listPlatformAiProviders(superAdministrator.client)).toEqual(expect.objectContaining({
      ok: true,
      value: expect.arrayContaining([{
        provider: "anthropic",
        available: true,
        splitModel: "claude-sonnet-split",
        extractModel: "claude-sonnet-extract",
        hasPlatformKey: true,
        platformKeyLastFour: "cret",
      }]),
    }));
  });

  it("resolves the encrypted platform key only for Organizations enabled by a SuperAdmin", async () => {
    const target = await administratorWithCompany("Enabled Organization");
    const superAdministrator = sharedSuperAdministrator;
    await configurePlatformAiProvider(superAdministrator.client, {
      provider: "anthropic",
      available: true,
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      apiKey: "sk-ant-platform-secret",
    });

    expect(await resolvePlatformAiProvider(systemClient(), target.organizationId, "anthropic")).toEqual({
      ok: false,
      error: "platform_key_not_enabled",
    });
    const organizations = await listPlatformOrganizations(superAdministrator.client, "anthropic");
    expect(organizations).toEqual(expect.objectContaining({
      ok: true,
      value: expect.arrayContaining([
        { id: target.organizationId, name: "Enabled Organization", platformKeyEnabled: false },
      ]),
    }));

    expect(await setOrganizationPlatformAiAccess(superAdministrator.client, {
      organizationId: target.organizationId,
      provider: "anthropic",
      enabled: true,
    })).toEqual({ ok: true, value: null });
    expect(await resolvePlatformAiProvider(systemClient(), target.organizationId, "anthropic")).toEqual({
      ok: true,
      value: {
        apiKey: "sk-ant-platform-secret",
        splitModel: "claude-sonnet-split",
        extractModel: "claude-sonnet-extract",
      },
    });
  });

  it("lists every Organization beyond the PostgREST row limit", async () => {
    const superAdministrator = sharedSuperAdministrator;
    const organizations = Array.from({ length: 1001 }, (_, index) => ({
      name: `Platform AI page ${index.toString().padStart(4, "0")}`,
    }));
    const inserted = await systemClient().from("organization").insert(organizations).select("id");
    if (inserted.error) throw inserted.error;

    const result = await listPlatformOrganizations(superAdministrator.client, "anthropic");

    expect(result).toEqual({ ok: true, value: expect.any(Array) });
    if (!result.ok) throw new Error(result.error);
    const insertedIds = new Set(inserted.data.map((organization) => organization.id));
    expect(result.value.filter((organization) => insertedIds.has(organization.id))).toHaveLength(1001);
  });

  it("does not offer or accept a platform key while Organization access is disabled", async () => {
    const target = await administratorWithCompany("Disabled Organization");
    const superAdministrator = sharedSuperAdministrator;
    await configurePlatformAiProvider(superAdministrator.client, {
      provider: "anthropic",
      available: true,
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      apiKey: "sk-ant-platform-secret",
    });
    const worker = testWorker(platformAnthropicAiProvider({ baseUrl: "http://127.0.0.1:9" }));
    expect(await listCompanyAiOptions(target.client, target.companyId)).not.toContainEqual({
      provider: "anthropic",
      region: "global",
      credentialSource: "platform",
    });
    expect(await enableAiProcessing(target.client, worker.jobs, {
      companyId: target.companyId,
      provider: worker.ai,
      credentialSource: "platform",
    })).toEqual({ ok: false, error: "provider_unavailable" });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs({ final: false })).toEqual([]);
    expect((await getSourceFile(target.client, target.companyId, uploaded.value.id))?.status).toBe("uploaded");
  });
});
