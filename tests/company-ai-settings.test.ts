import { beforeAll, describe, expect, it } from "vitest";
import {
  configureCompanyAiProcessing,
  disableAiProcessing,
  getCompany,
  getCompanySetupChecklist,
  listCompanyAiOptions,
} from "@/application/companies";
import { saveOrganizationAiProviderKey } from "@/application/organization-ai";
import { configurePlatformAiProvider, setOrganizationPlatformAiAccess } from "@/application/platform-ai";
import { uploadSourceFile } from "@/application/source-files";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import { companyMember, administratorWithCompany, companyWithWaitingDocuments } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";

let superAdministrator: Awaited<ReturnType<typeof promotedSuperAdministrator>>;

beforeAll(async () => {
  superAdministrator = await promotedSuperAdministrator("Company AI SuperAdmin", "company-ai-settings");
});

describe("Company AI settings", () => {
  it("offers only usable platform and BYOK choices and resolves exactly the selected source", async () => {
    const company = await administratorWithCompany("Explicit AI choices");
    const resolvedKeys: string[] = [];
    const worker = testWorker({
      name: "openai",
      region: "global",
      async split(_input, context) {
        resolvedKeys.push(context?.configuration?.apiKey ?? "missing");
        return { model: "gpt-split", documents: [{ firstPage: 1, lastPage: 1 }] };
      },
      async extract(_input, context) {
        resolvedKeys.push(context?.configuration?.apiKey ?? "missing");
        return { model: "gpt-extract", payload: SAMPLE_EXTRACTION };
      },
    });

    expect(await listCompanyAiOptions(company.client, company.companyId)).toEqual([]);

    expect(await configurePlatformAiProvider(superAdministrator.client, {
      provider: "openai",
      available: true,
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      apiKey: "sk-platform-company-settings",
    })).toEqual({ ok: true, value: null });
    expect(await setOrganizationPlatformAiAccess(superAdministrator.client, {
      organizationId: company.organizationId,
      provider: "openai",
      enabled: true,
    })).toEqual({ ok: true, value: null });

    expect(await listCompanyAiOptions(company.client, company.companyId)).toContainEqual({
      provider: "openai",
      region: "global",
      credentialSource: "platform",
    });
    expect(await configureCompanyAiProcessing(company.client, worker.jobs, {
      companyId: company.companyId,
      option: { provider: "openai", region: "global", credentialSource: "platform" },
      consent: true,
    })).toEqual({ ok: true, value: null });
    const platformFile = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "platform.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!platformFile.ok) throw new Error(platformFile.error);
    expect(await worker.runJobs()).toEqual([]);
    expect(resolvedKeys).toHaveLength(2);
    expect(resolvedKeys).not.toContain("missing");

    expect(await saveOrganizationAiProviderKey(company.client, {
      organizationId: company.organizationId,
      provider: "openai",
      apiKey: "sk-organization-company-settings",
      dpaAcknowledged: true,
    })).toEqual({ ok: true, value: null });
    const options = await listCompanyAiOptions(company.client, company.companyId);
    expect(options).toEqual(expect.arrayContaining([
      { provider: "openai", region: "global", credentialSource: "platform" },
      { provider: "openai", region: "global", credentialSource: "organization" },
    ]));
    expect(JSON.stringify(options)).not.toContain("company-settings");

    expect(await configurePlatformAiProvider(superAdministrator.client, {
      provider: "openai",
      available: false,
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
    })).toEqual({ ok: true, value: null });
    expect(await listCompanyAiOptions(company.client, company.companyId)).toEqual([
      { provider: "openai", region: "global", credentialSource: "organization" },
    ]);

    expect(await configureCompanyAiProcessing(company.client, worker.jobs, {
      companyId: company.companyId,
      option: { provider: "openai", region: "global", credentialSource: "organization" },
      consent: true,
    })).toEqual({ ok: true, value: null });
    const organizationFile = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "organization.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!organizationFile.ok) throw new Error(organizationFile.error);
    expect(await worker.runJobs()).toEqual([]);
    expect(resolvedKeys.slice(-2)).toEqual([
      "sk-organization-company-settings",
      "sk-organization-company-settings",
    ]);
    expect(await getCompany(company.client, company.companyId)).toEqual(expect.objectContaining({
      aiProcessing: {
        provider: "openai",
        region: "global",
        credentialSource: "organization",
      },
    }));
    expect(await configurePlatformAiProvider(superAdministrator.client, {
      provider: "openai",
      available: true,
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
    })).toEqual({ ok: true, value: null });
    expect(await configureCompanyAiProcessing(company.client, worker.jobs, {
      companyId: company.companyId,
      option: { provider: "openai", region: "global", credentialSource: "platform" },
      consent: true,
    })).toEqual({ ok: true, value: null });
    const platformAfterByok = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "platform-after-byok.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!platformAfterByok.ok) throw new Error(platformAfterByok.error);
    expect(await worker.runJobs()).toEqual([]);
    expect(resolvedKeys.slice(-2)).not.toContain("sk-organization-company-settings");
    expect(resolvedKeys.slice(-2)).not.toContain("missing");
  });

  it("lets a regular User see waiting/configured status but neither options nor mutation authority", async () => {
    const company = await administratorWithCompany("AI status readers");
    const member = await companyMember(company, "user");
    const jobs = { async send() {} };

    expect((await getCompany(member.client, company.companyId))?.aiProcessing).toBeNull();
    expect(await listCompanyAiOptions(member.client, company.companyId)).toEqual([]);
    expect(await configureCompanyAiProcessing(company.client, jobs, {
      companyId: company.companyId,
      option: { provider: "fake", region: "local", credentialSource: "local" },
      consent: false,
    })).toEqual({ ok: false, error: "consent_required" });
    expect(await configureCompanyAiProcessing(member.client, jobs, {
      companyId: company.companyId,
      option: { provider: "fake", region: "local", credentialSource: "local" },
      consent: true,
    })).toEqual({ ok: false, error: "forbidden" });

    expect(await configureCompanyAiProcessing(company.client, jobs, {
      companyId: company.companyId,
      option: { provider: "fake", region: "local", credentialSource: "local" },
      consent: true,
    })).toEqual({ ok: true, value: null });
    expect((await getCompany(member.client, company.companyId))?.aiProcessing).toEqual({
      provider: "fake",
      region: "local",
      credentialSource: "local",
    });
    expect(JSON.stringify(await getCompany(member.client, company.companyId))).not.toContain("secret");

    expect(await disableAiProcessing(member.client, company.companyId)).toEqual({ ok: false, error: "forbidden" });
    expect(await disableAiProcessing(company.client, company.companyId)).toEqual({ ok: true, value: null });
    expect((await getCompanySetupChecklist(company.client, company.companyId)).find(({ step }) =>
      step === "ai_processing"
    )).toEqual({ step: "ai_processing", state: "skipped" });
  });

  it("re-enqueues every waiting Document beyond the PostgREST row limit", async () => {
    const company = await companyWithWaitingDocuments(1_050);
    const sent: { name: string; data: unknown }[] = [];

    expect(await configureCompanyAiProcessing(company.client, {
      async send(job) { sent.push(job); },
    }, {
      companyId: company.companyId,
      option: { provider: "fake", region: "local", credentialSource: "local" },
      consent: true,
    })).toEqual({ ok: true, value: null });

    expect(sent).toHaveLength(1_050);
    expect(sent.every((job) => job.name === "extract-document")).toBe(true);
    expect(new Set(sent.map((job) => JSON.stringify(job.data))).size).toBe(1_050);
  });
});
