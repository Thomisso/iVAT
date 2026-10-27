import { describe, expect, it } from "vitest";
import { AiProviderError } from "@/application/ai-provider";
import { enableAiProcessing } from "@/application/companies";
import {
  configurePlatformAiProvider,
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
  const { error } = await systemClient().auth.admin.updateUserById(user.userId, {
    app_metadata: { role: "super_admin" },
  });
  if (error) throw error;
  const refreshed = await user.client.auth.refreshSession();
  if (refreshed.error) throw refreshed.error;
  return user;
}

describe("platform AI provider settings", () => {
  it("lets only a SuperAdmin store a platform key and never returns the key", async () => {
    const ordinaryAdministrator = await signedUpUser("Ordinary Organization");
    const superAdministrator = await superAdmin();
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
    expect(await listPlatformAiProviders(ordinaryAdministrator.client)).toEqual({
      ok: false,
      error: "forbidden",
    });

    expect(await configurePlatformAiProvider(superAdministrator.client, settings)).toEqual({ ok: true, value: null });
    expect(await listPlatformAiProviders(superAdministrator.client)).toEqual({
      ok: true,
      value: [{
        provider: "anthropic",
        available: true,
        splitModel: "claude-sonnet-split",
        extractModel: "claude-sonnet-extract",
        hasPlatformKey: true,
        platformKeyLastFour: "cret",
      }],
    });
  });

  it("resolves the encrypted platform key only for Organizations enabled by a SuperAdmin", async () => {
    const target = await administratorWithCompany("Enabled Organization");
    const superAdministrator = await superAdmin();
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

  it("fails processing clearly without sending a Document when platform-key access is disabled", async () => {
    const target = await administratorWithCompany("Disabled Organization");
    const superAdministrator = await superAdmin();
    await configurePlatformAiProvider(superAdministrator.client, {
      provider: "anthropic",
      available: true,
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      apiKey: "sk-ant-platform-secret",
    });
    const worker = testWorker(platformAnthropicAiProvider(systemClient(), { baseUrl: "http://127.0.0.1:9" }));
    await enableAiProcessing(target.client, worker.jobs, { companyId: target.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    const [error] = await worker.runJobs({ final: false });

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ code: "platform_key_not_enabled", transient: false });
    expect((await getSourceFile(target.client, target.companyId, uploaded.value.id))?.status).toBe("failed");
  });
});
