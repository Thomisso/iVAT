import { describe, expect, it } from "vitest";
import type { AiCallContext, AiProvider } from "@/application/ai-provider";
import { listAuditEvents, listPlatformAuditEvents } from "@/application/audit";
import {
  assignCompanyAiConfiguration,
  createAiConfiguration,
  listAiConfigurations,
  setDefaultAiConfiguration,
  updateAiConfiguration,
} from "@/application/ai-configurations";
import { enableAiProcessing } from "@/application/companies";
import { listCompanyDocuments } from "@/application/documents";
import { getSourceFile, uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider } from "@/ai/fake";
import { administratorWithCompany } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";

describe("platform-owned AI Configurations", () => {
  it("lets only a SuperAdmin create, update and inspect secret-free configurations", async () => {
    const superAdministrator = await promotedSuperAdministrator("AI Configuration operator", "ai-configuration");
    const ordinaryAdministrator = await administratorWithCompany("AI Configuration outsider");
    const originalLabel = `Shared production ${superAdministrator.userId}`;
    const updatedLabel = `Dedicated ${superAdministrator.userId}`;
    const input = {
      label: originalLabel,
      provider: "anthropic",
      splitModel: "claude-split-v1",
      extractModel: "claude-extract-v1",
      credential: "sk-ant-original-secret",
    };

    expect(await createAiConfiguration(ordinaryAdministrator.client, input)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listAiConfigurations(ordinaryAdministrator.client)).toEqual({
      ok: false,
      error: "forbidden",
    });

    const created = await createAiConfiguration(superAdministrator.client, input);
    expect(created).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!created.ok) throw new Error(created.error);

    const afterCreate = await listAiConfigurations(superAdministrator.client);
    expect(afterCreate).toEqual({ ok: true, value: expect.any(Array) });
    if (!afterCreate.ok) throw new Error(afterCreate.error);
    expect(afterCreate.value.find(({ id }) => id === created.value.id)).toEqual({
        id: created.value.id,
        label: originalLabel,
        provider: "anthropic",
        credentialLastFour: "cret",
        isDefault: false,
        assignedCompanyIds: [],
    });

    expect(await updateAiConfiguration(ordinaryAdministrator.client, {
      id: created.value.id,
      label: updatedLabel,
      provider: "anthropic",
      splitModel: "claude-split-v2",
      extractModel: "claude-extract-v2",
      credential: "sk-ant-replacement",
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateAiConfiguration(superAdministrator.client, {
      id: created.value.id,
      label: updatedLabel,
      provider: "anthropic",
      splitModel: "claude-split-v2",
      extractModel: "claude-extract-v2",
      credential: "sk-ant-replacement",
    })).toEqual({ ok: true, value: null });

    const listed = await listAiConfigurations(superAdministrator.client);
    expect(listed).toEqual({ ok: true, value: expect.any(Array) });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.find(({ id }) => id === created.value.id)).toEqual({
        id: created.value.id,
        label: updatedLabel,
        provider: "anthropic",
        credentialLastFour: "ment",
        isDefault: false,
        assignedCompanyIds: [],
    });
    expect(JSON.stringify(listed)).not.toContain("original-secret");
    expect(JSON.stringify(listed)).not.toContain("replacement");
    expect(JSON.stringify(listed)).not.toContain("claude-split");
    expect(JSON.stringify(listed)).not.toContain("claude-extract");

    const directRead = await superAdministrator.client.from("ai_configuration").select("*");
    const credentialRpc = await superAdministrator.client.rpc("resolve_assigned_ai_configuration", {
      target_company_id: ordinaryAdministrator.companyId,
    });
    expect(directRead.error?.code).toBe("42501");
    expect(credentialRpc.error?.code).toBe("42501");
  });

  it("assigns one configuration to many Companies, selects one default, and audits every change", async () => {
    const superAdministrator = await promotedSuperAdministrator("AI assignment operator", "ai-assignment");
    const firstCompany = await administratorWithCompany("Assigned Company One");
    const secondCompany = await administratorWithCompany("Assigned Company Two");
    const outsider = await administratorWithCompany("AI assignment outsider");
    const labelSuffix = superAdministrator.userId;
    const first = await createAiConfiguration(superAdministrator.client, {
      label: `Assignment shared ${labelSuffix}`,
      provider: "anthropic",
      splitModel: "split-1",
      extractModel: "extract-1",
      credential: "shared-secret",
    });
    const second = await createAiConfiguration(superAdministrator.client, {
      label: `Assignment dedicated ${labelSuffix}`,
      provider: "openai",
      splitModel: "split-2",
      extractModel: "extract-2",
      credential: "dedicated-secret",
    });
    if (!first.ok || !second.ok) throw new Error("Configuration creation failed");

    expect(await assignCompanyAiConfiguration(outsider.client, {
      companyId: firstCompany.companyId,
      configurationId: first.value.id,
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await setDefaultAiConfiguration(outsider.client, first.value.id)).toEqual({
      ok: false,
      error: "forbidden",
    });

    expect(await assignCompanyAiConfiguration(superAdministrator.client, {
      companyId: firstCompany.companyId,
      configurationId: first.value.id,
    })).toEqual({ ok: true, value: null });
    expect(await assignCompanyAiConfiguration(superAdministrator.client, {
      companyId: secondCompany.companyId,
      configurationId: first.value.id,
    })).toEqual({ ok: true, value: null });
    expect(await setDefaultAiConfiguration(superAdministrator.client, first.value.id)).toEqual({
      ok: true,
      value: null,
    });
    expect(await setDefaultAiConfiguration(superAdministrator.client, second.value.id)).toEqual({
      ok: true,
      value: null,
    });

    const listed = await listAiConfigurations(superAdministrator.client);
    expect(listed).toEqual({ ok: true, value: expect.any(Array) });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.filter(({ id }) => id === first.value.id || id === second.value.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: second.value.id,
          isDefault: true,
          assignedCompanyIds: [],
        }),
        expect.objectContaining({
          id: first.value.id,
          isDefault: false,
          assignedCompanyIds: [firstCompany.companyId, secondCompany.companyId].sort(),
        }),
      ]),
    );

    expect((await listPlatformAuditEvents(superAdministrator.client)).map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "ai_configuration.created",
        "ai_configuration.default_selected",
      ]),
    );
    expect((await listAuditEvents(firstCompany.client, firstCompany.organizationId)).map((event) => event.action))
      .toContain("company.ai_configuration_assigned");
  });

  it("processes Split and Extraction through an assigned configuration while retaining the legacy path", async () => {
    const superAdministrator = await promotedSuperAdministrator("AI processing operator", "ai-processing");
    const configuredCompany = await administratorWithCompany("Configured processing");
    const seenContexts: AiCallContext[] = [];
    const fake = fakeAiProvider();
    const configuredProvider: AiProvider = {
      name: "anthropic",
      region: "global",
      async split(input, context) {
        if (context) seenContexts.push(context);
        return fake.split(input, context);
      },
      async extract(input, context) {
        if (context) seenContexts.push(context);
        return fake.extract(input, context);
      },
    };
    const worker = testWorker(configuredProvider);
    const configuration = await createAiConfiguration(superAdministrator.client, {
      label: `Worker path ${superAdministrator.userId}`,
      provider: "anthropic",
      splitModel: "configured-split",
      extractModel: "configured-extract",
      credential: "configured-secret",
    });
    if (!configuration.ok) throw new Error(configuration.error);
    expect(await assignCompanyAiConfiguration(superAdministrator.client, {
      companyId: configuredCompany.companyId,
      configurationId: configuration.value.id,
    })).toEqual({ ok: true, value: null });

    const uploaded = await uploadSourceFile(configuredCompany.client, worker.jobs, {
      companyId: configuredCompany.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    expect((await getSourceFile(configuredCompany.client, configuredCompany.companyId, uploaded.value.id))?.status)
      .toBe("split");
    expect(await listCompanyDocuments(configuredCompany.client, configuredCompany.companyId)).toEqual([
      expect.objectContaining({ status: "needs_review" }),
    ]);
    expect(seenContexts).toEqual([
      expect.objectContaining({
        credentialSource: "platform",
        configuration: {
          apiKey: "configured-secret",
          splitModel: "configured-split",
          extractModel: "configured-extract",
        },
      }),
      expect.objectContaining({
        credentialSource: "platform",
        configuration: {
          apiKey: "configured-secret",
          splitModel: "configured-split",
          extractModel: "configured-extract",
        },
      }),
    ]);

    const legacyCompany = await administratorWithCompany("Legacy processing");
    const legacyWorker = testWorker();
    expect(await enableAiProcessing(legacyCompany.client, legacyWorker.jobs, {
      companyId: legacyCompany.companyId,
      provider: legacyWorker.ai,
    })).toEqual({ ok: true, value: null });
    const legacyUpload = await uploadSourceFile(legacyCompany.client, legacyWorker.jobs, {
      companyId: legacyCompany.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!legacyUpload.ok) throw new Error(legacyUpload.error);
    expect(await legacyWorker.runJobs()).toEqual([]);
    expect(await listCompanyDocuments(legacyCompany.client, legacyCompany.companyId)).toEqual([
      expect.objectContaining({ status: "needs_review" }),
    ]);
  });
});
