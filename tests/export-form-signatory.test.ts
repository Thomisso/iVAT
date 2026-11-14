// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanyFilingDefaults } from "@/application/company-filing-defaults";

vi.mock("next-intl", () => ({ useTranslations: () => Object.assign((key: string) => key, { has: () => true }) }));
// Only the framework action transport is unavailable in this DOM model. No
// action is invoked here; real Auth HTTP and application tests cover submission.
vi.mock("@/app/actions", () => ({ saveCompanyFilingDefaultsAction: vi.fn(), acknowledgeVatReportDownloadAction: vi.fn() }));

import { ExportForm } from "@/app/companies/[companyId]/vat-reports/export-form";
import { ExportContextProvider } from "@/app/companies/[companyId]/vat-reports/export-context";

const defaults: CompanyFilingDefaults = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: null, signatoryLastName: null, signatoryCapacity: null, email: null, phone: null, epoAddressOverride: null };
const address = { streetName: "Vinohradská", houseNumber: "12", orientationNumber: null, city: "Praha", postalCode: "120 00" };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

// createElement does not infer the provider's required child prop from its
// child argument; the child is always supplied below.
it.each(["4a/P", "4c/P"])("permits a legal taxpayer's complete %s override without an unrelated direct signatory", async variant => {
  await act(async () => root.render(createElement(ExportContextProvider, { preparedOn: "2026-10-27" } as ComponentProps<typeof ExportContextProvider>, createElement(ExportForm, {
    companyId: "00000000-0000-4000-8000-000000000001", format: "dphdp3", period: "2026-10", preparedOn: "2026-10-27",
    personType: "legal", defaults, epoAddress: { address, source: "registered" }, finalized: false,
  }))));
  const form = container.querySelector("form")!;
  expect(form.checkValidity()).toBe(false);
  const selection = form.querySelector<HTMLSelectElement>('[name="representativeVariant"]')!;
  await act(async () => { selection.value = variant; selection.dispatchEvent(new Event("change", { bubbles: true })); });
  for (const [name, value] of Object.entries({ representativeName: "Atlas Poradenství s.r.o.", representativeIco: "00123456", representativeSignatoryFirstName: "Irena", representativeSignatoryLastName: "Podpisová", representativeSignatoryCapacity: "jednatelka" })) {
    const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    input.value = value;
  }
  // Observe the actual public form's constraint model, without reproducing a
  // signatory-selection helper or claiming native-browser interaction proof.
  expect(form.querySelectorAll('[name="signatoryFirstName"][required], [name="signatoryLastName"][required], [name="signatoryCapacity"][required]')).toHaveLength(0);
  expect(form.checkValidity()).toBe(true);
});


it.each([true, false])("restores direct constraints and preserves dirty fields through default/off/variant/reset transitions (shared context %s)", async shared => {
  const legalDefaults = { ...defaults, representative: { code: "4c", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } } as const;
  const formElement = createElement(ExportForm, { companyId: "00000000-0000-4000-8000-000000000001", format: "dphkh1", period: "2026-10", preparedOn: "2026-10-27", personType: "legal", defaults: legalDefaults, epoAddress: { address, source: "registered" }, finalized: false });
  await act(async () => root.render(shared ? createElement(ExportContextProvider, { preparedOn: "2026-10-27" } as ComponentProps<typeof ExportContextProvider>, formElement) : formElement));
  const form = container.querySelector("form")!;
  const button = (name: string) => [...form.querySelectorAll("button")].find(item => item.textContent === name)!;
  const requiredDirectInputs = () => form.querySelectorAll('input[name^="signatory"][required]');
  const select = async (variant: string) => act(async () => {
    const selection = form.querySelector<HTMLSelectElement>('[name="representativeVariant"]')!;
    selection.value = variant; selection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("editForExport").click());
  expect(requiredDirectInputs()).toHaveLength(0);
  expect(form.checkValidity()).toBe(true);
  await select("off");
  expect(requiredDirectInputs()).toHaveLength(3);
  expect(form.checkValidity()).toBe(false);
  await act(async () => {
    for (const [name, value] of Object.entries({ signatoryFirstName: "Jana", signatoryLastName: "Stará", signatoryCapacity: "jednatelka" })) form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  });
  expect(form.checkValidity()).toBe(true);
  for (const variant of ["4a", "4b"]) { await select(variant); expect(requiredDirectInputs()).toHaveLength(3); }
  for (const variant of ["4a/P", "4c/P", "default"]) { await select(variant); expect(requiredDirectInputs()).toHaveLength(0); }
  await select("off");
  expect(requiredDirectInputs()).toHaveLength(3);
  expect(form.querySelector<HTMLInputElement>('[name="signatoryFirstName"]')!.value).toBe("Jana");
  expect(form.checkValidity()).toBe(true);
  await select("4a/P");
  await act(async () => button("useSaved").click());
  expect(form.querySelector<HTMLSelectElement>('[name="representativeVariant"]')!.value).toBe("default");
  expect(form.querySelector('[name="signatoryFirstName"]')).toBeNull();
  // Turning a complete PO default off must reveal missing direct inputs even
  // when the editor was closed. They cannot wait for an avoidable XML refusal.
  await select("off");
  expect(requiredDirectInputs()).toHaveLength(3);
  expect(form.querySelector<HTMLInputElement>('[name="signatoryFirstName"]')!.value).toBe("");
  expect(form.checkValidity()).toBe(false);
});

it("retains a refused PO override without restoring irrelevant direct-signatory constraints", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_representative" }), { status: 422, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(createElement(ExportForm, { companyId: "00000000-0000-4000-8000-000000000001", format: "dphdp3", period: "2026-10", preparedOn: "2026-10-27", personType: "legal", defaults, epoAddress: { address, source: "registered" }, finalized: false })));
  const form = container.querySelector("form")!;
  await act(async () => {
    const selection = form.querySelector<HTMLSelectElement>('[name="representativeVariant"]')!;
    selection.value = "4a/P"; selection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  form.querySelector<HTMLInputElement>('[name="representativeName"]')!.value = "Incomplete legal profile";
  expect(form.checkValidity()).toBe(true);
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledOnce();
  expect(form.textContent).toContain("invalid_representative");
  expect(form.querySelector<HTMLSelectElement>('[name="representativeVariant"]')!.value).toBe("4a/P");
  expect(form.querySelector<HTMLInputElement>('[name="representativeName"]')!.value).toBe("Incomplete legal profile");
  expect(form.querySelectorAll('input[name^="signatory"][required]')).toHaveLength(0);
});
