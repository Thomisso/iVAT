import { afterEach, expect, it, vi } from "vitest";
import { configuredVatPayerRegistry } from "@/vat-registry";
import { configuredExchangeRates } from "@/cnb";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { listDocuments, listExtractionVersions } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("runs configured fake VAT and exchange-rate checks through Extraction without external HTTP", async () => {
  vi.stubEnv("VAT_REGISTRY_PROVIDER", "fake");
  vi.stubEnv("EXCHANGE_RATE_PROVIDER", "fake");
  const actualFetch = globalThis.fetch;
  const externalRequests: string[] = [];
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      externalRequests.push(url.href);
      throw new Error("External HTTP is forbidden in this test");
    }
    return actualFetch(input, init);
  }) as typeof fetch);
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, currency: "EUR" }) }),
    configuredVatPayerRegistry(), configuredExchangeRates());
  const company = await administratorWithCompany();
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  const [version] = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(version.payload.czkConversion).toEqual(expect.objectContaining({ rate: "25.00", originalCurrency: "EUR" }));
  expect(version.findings).toEqual([]);
  expect(externalRequests).toEqual([]);
});

it("refuses unknown explicit modes instead of silently selecting a live dependency", () => {
  vi.stubEnv("VAT_REGISTRY_PROVIDER", "unexpected");
  vi.stubEnv("EXCHANGE_RATE_PROVIDER", "unexpected");
  expect(() => configuredVatPayerRegistry()).toThrow("Unknown VAT_REGISTRY_PROVIDER");
  expect(() => configuredExchangeRates()).toThrow("Unknown EXCHANGE_RATE_PROVIDER");
});

it("keeps live registry and rate adapters as defaults even when AI alone is fake", async () => {
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("VAT_REGISTRY_PROVIDER", undefined);
  vi.stubEnv("EXCHANGE_RATE_PROVIDER", undefined);
  const requests: string[] = [];
  vi.stubGlobal("fetch", (async (input) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return new Response(null, { status: 503 });
  }) as typeof fetch);
  expect(await configuredVatPayerRegistry().check("CZ27082440")).toEqual({ outcome: "unavailable" });
  expect(await configuredExchangeRates().rateFor("2026-10-01", "EUR")).toBeNull();
  expect(requests).toEqual([
    "https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP",
    "https://api.cnb.cz/cnbapi/exrates/daily?date=2026-10-01&lang=EN",
  ]);
});
