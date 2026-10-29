// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CompanyDataExportForm } from "@/app/companies/[companyId]/settings/company-data-export-form";

const companyId = "00000000-0000-4000-8000-000000000001";

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:company-export"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("downloads Company data without requesting Company deletion", async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(new Blob(["archive"]), {
    headers: { "Content-Disposition": 'attachment; filename="company-data.zip"' },
  })));
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    root?.render(createElement(CompanyDataExportForm, { companyId }));
  });

  const form = container.querySelector("form");
  if (!form) throw new Error("Company data export form did not render");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(`/companies/${companyId}/export`, { method: "POST" });
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  const anchor = container.querySelector("a");
  expect(anchor).toBeNull();
  expect(container.textContent).toContain("dataExportDownloaded");
});

it("shows a safe refusal without attempting a browser download", async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    root?.render(createElement(CompanyDataExportForm, { companyId }));
  });

  const form = container.querySelector("form");
  if (!form) throw new Error("Company data export form did not render");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(container.textContent).toContain("dataExportFailed");
});
