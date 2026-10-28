// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { CompanyDeletionForm } from "@/app/companies/[companyId]/settings/company-deletion-form";
import { rememberPendingCompanyExport } from "@/lib/company-export-polling";

const companyId = "00000000-0000-4000-8000-000000000001";
const resumedExportId = "00000000-0000-4000-8000-000000000002";
const freshExportId = "00000000-0000-4000-8000-000000000003";

type FetchCall = { url: string; signal?: AbortSignal };

let container: HTMLDivElement;
let root: Root | null;
let calls: FetchCall[];

function pendingResponse(signal?: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function installFetch(exportStatus: "pending" | "completed" = "pending"): void {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, signal: init?.signal ?? undefined });
    if (url.endsWith("/export")) {
      return Promise.resolve(new Response(new Blob(["archive"]), {
        headers: {
          "Content-Disposition": "attachment; filename=\"archive.zip\"",
          "X-Company-Export-Id": freshExportId,
        },
      }));
    }
    if (url.includes("/exports/")) {
      if (exportStatus === "pending") return pendingResponse(init?.signal ?? undefined);
      return Promise.resolve(Response.json(exportStatus));
    }
    if (url.endsWith("/delete")) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }));
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CompanyDeletionForm, { companyId }));
  });
}

async function submit(): Promise<void> {
  const form = container.querySelector("form");
  if (!form) throw new Error("Deletion form did not render");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
}

function statusCalls(): FetchCall[] {
  return calls.filter(({ url }) => url.includes("/exports/"));
}

function deleteCalls(): FetchCall[] {
  return calls.filter(({ url }) => url.endsWith("/delete"));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = null;
  sessionStorage.clear();
  router.replace.mockReset();
  Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:company-export"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  installFetch();
});

afterEach(async () => {
  if (root) await unmount();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompanyDeletionForm workflow lifecycle", () => {
  it("aborts a fresh pending export when the form unmounts and never deletes", async () => {
    await mount();
    await submit();
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));

    const signal = statusCalls()[0]?.signal;
    expect(signal?.aborted).toBe(false);
    await unmount();

    expect(signal?.aborted).toBe(true);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("aborts a resumed pending export when the form unmounts and never deletes", async () => {
    rememberPendingCompanyExport(sessionStorage, companyId, resumedExportId);
    await mount();
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));

    const signal = statusCalls()[0]?.signal;
    await unmount();

    expect(signal?.aborted).toBe(true);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("replaces a resumed controller without letting its cleanup miss the fresh workflow", async () => {
    rememberPendingCompanyExport(sessionStorage, companyId, resumedExportId);
    await mount();
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));
    const resumedSignal = statusCalls()[0]?.signal;

    await submit();
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(2));
    const freshSignal = statusCalls()[1]?.signal;
    expect(resumedSignal?.aborted).toBe(true);
    expect(freshSignal?.aborted).toBe(false);

    await unmount();

    expect(freshSignal?.aborted).toBe(true);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("releases a completed workflow before the component later unmounts", async () => {
    installFetch("completed");
    await mount();
    await submit();
    await vi.waitFor(() => expect(deleteCalls()).toHaveLength(1));
    const completedSignal = statusCalls()[0]?.signal;

    await unmount();

    expect(completedSignal?.aborted).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
