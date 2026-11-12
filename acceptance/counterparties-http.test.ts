import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { listCounterparties } from "@/application/counterparties";
import { administratorWithCompany, knownSupplierFixture } from "../tests/support/fixtures";
import { legacyCounterpartyTradeFixture, withUnavailableCounterpartyStatistics } from "../tests/support/counterparty-statistics";
import { httpAs } from "./support/http";

it("returns localized trade statistics, exact DUZP drill-down and refusal through authenticated HTTP", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const base = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id } };
  const ids = await legacyCounterpartyTradeFixture(owner, [
    { payload: { ...base, documentNumber: "TRADE-OCTOBER", taxPointDate: "2026-10-01" } },
    { payload: { ...base, documentNumber: "TRADE-DECEMBER", taxPointDate: "2026-12-31" } },
    { payload: { ...base, documentNumber: "TRADE-UNDATED", taxPointDate: null } },
    { payload: { ...base, documentNumber: "TRADE-GROSS-ADVISORY", taxPointDate: "2020-01-01", totals: { netAmount: "0.01", vatAmount: "0.02", grossAmount: "0.04" } } },
    { payload: { ...base, documentNumber: "TRADE-PRESENTATION-LARGE", taxPointDate: "2022-10-14", totals: { netAmount: "-9007199254740993.01", vatAmount: "0.00", grossAmount: "-9007199254740993.01" } } },
    { payload: { ...base, documentNumber: "TRADE-PRESENTATION-GROUPED", taxPointDate: "2022-10-14", totals: { netAmount: "24200.00", vatAmount: "0.00", grossAmount: "24200.00" } } },
  ]);
  const path = `/companies/${owner.companyId}/counterparties/${party.id}`;
  const request = await httpAs(owner.client);
  const response = await request(`${path}?from=2026-10-01&to=2026-10-01`);
  expect(response.status).toBe(200);
  const html = await response.text();
  const trade = html.match(/<section aria-label="Trade statistics"[\s\S]*?<\/section>/)?.[0];
  expect(trade).toBeDefined();
  expect(trade).toContain("Tax Point Date");
  expect(trade).toContain("1 210,00");
  expect(trade).toContain("TRADE-OCTOBER");
  expect(trade).not.toContain("TRADE-DECEMBER");
  expect(trade).not.toContain("TRADE-UNDATED");
  expect(trade).toContain(`documents/${ids[0]}?version=1`);
  expect(trade).toContain("returnTo=");
  expect(trade).toContain("contribution=complete");
  const documentLink = trade!.match(new RegExp(`href="([^"]*documents/${ids[0]}[^\"]*)"`))?.[1].replaceAll("&amp;", "&");
  expect(documentLink).toBeDefined();
  const document = await request(documentLink!);
  expect(document.status).toBe(200);
  const returnTo = new URL(documentLink!, "http://127.0.0.1").searchParams.get("returnTo")!;
  expect(await document.text()).toContain(`href="${returnTo.replaceAll("&", "&amp;")}"`);
  const missing = await request(`${path}?year=2026&contribution=missing_date`);
  expect(await missing.text()).toContain("TRADE-UNDATED");
  const cs = await (await httpAs(owner.client, "cs"))(`${path}?year=2026`);
  expect(await cs.text()).toContain("Obchodní statistiky");
  const discrepancy = await request(`${path}?year=2020`);
  expect(await discrepancy.text()).toContain("Stored gross differs from net + VAT");
  const presentation = await request(`${path}?from=2022-10-14&to=2022-10-14`);
  const presentedTrade = (await presentation.text()).match(/<section aria-label="Trade statistics"[\s\S]*?<\/section>/)?.[0];
  expect(presentedTrade).toContain("−9 007 199 254 740 993,01");
  expect(presentedTrade).toContain("−9 007 199 254 716 793,01");
  expect(presentedTrade).toContain("24 200,00");
  expect(presentedTrade).toContain('class="iv-money is-negative');
  expect(presentedTrade).toContain("Tax Point Date: 14.10.2022 – 14.10.2022");
  expect(presentedTrade).toContain(">14.10.2022</td>");
  expect(presentedTrade).toMatch(/<input[^>]*value="2022-10-14"[^>]*name="from"|<input[^>]*name="from"[^>]*value="2022-10-14"/);
  const invalid = await request(`${path}?from=2026-02-30`);
  expect(await invalid.text()).toContain("Choose a valid Tax Point Date range and filters");
  await withUnavailableCounterpartyStatistics(async () => {
    const failure = await request(`${path}?year=2026`);
    const failedSection = (await failure.text()).match(/<section aria-label="Trade statistics"[\s\S]*?<\/section>/)?.[0];
    expect(failedSection).toContain("Trade statistics are unavailable");
    expect(failedSection).not.toContain("Matching Documents: 0");
  });
  const stranger = await administratorWithCompany();
  const foreign = await (await httpAs(stranger.client))(`${path}?year=2026`);
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).not.toContain("TRADE-OCTOBER");
});
