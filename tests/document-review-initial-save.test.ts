// @vitest-environment happy-dom

import { act, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { AppClient } from "@/application/client";

const boundary = vi.hoisted(() => ({ client: null as AppClient | null, save: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key, getLocale: async () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error("not found"); } }));
vi.mock("@/lib/supabase/server", () => ({
  requireUserClient: async () => boundary.client,
  availableAuthValue: (result: { ok: boolean; value: unknown }) => { if (!result.ok) throw new Error("Auth unavailable"); return result.value; },
}));
// Replace only the framework action transport; the mutation below uses the real User's public command.
vi.mock("@/app/actions", () => ({
  reviewDocumentAction: (...args: unknown[]) => boundary.save(...args),
  createManualDocumentAction: vi.fn(), refreshBankAccountCheckAction: vi.fn(),
  startManualDocumentReviewAction: vi.fn(), restoreDocumentAction: vi.fn(), reprocessDocumentAction: vi.fn(),
  returnDocumentToReviewAction: vi.fn(), updateDocumentReportingAction: vi.fn(), rejectDocumentAction: vi.fn(),
  attachDocumentSourceAction: vi.fn(),
}));

import DocumentReviewPage from "@/app/companies/[companyId]/documents/[documentId]/page";
import { CorrectionForm } from "@/app/companies/[companyId]/documents/[documentId]/correction-form";
import { ReviewGuard, useReviewDraft } from "@/app/companies/[companyId]/documents/[documentId]/review-guard";
import { correctDocument, listDocuments, listExtractionVersions, startManualDocumentReview } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { administratorWithCompany, assignAiConfigurationFixture, knownSupplierFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  boundary.client = null;
  boundary.save.mockReset();
});

// Use the actual server page's chosen element and key, rather than reproducing its conditional in a harness.
function correctionElement(node: ReactNode): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) { const found = correctionElement(child); if (found) return found; }
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === CorrectionForm) return node;
    return correctionElement(node.props.children);
  }
  return null;
}

it("completes departure Save when a recovered version-zero editor records its first public User Version", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  boundary.client = owner.client;
  const worker = testWorker(fakeAiProvider({ extract: () => { throw new Error("provider unavailable"); } }));
  await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId,
    fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toHaveLength(1);
  const [reviewedDocument] = await listDocuments(owner.client, owner.companyId, uploaded.value.id);
  const target = { companyId: owner.companyId, documentId: reviewedDocument.id };
  expect(await startManualDocumentReview(owner.client, target)).toEqual({ ok: true, value: null });
  expect(await listExtractionVersions(owner.client, owner.companyId, reviewedDocument.id)).toEqual([]);
  const departed = vi.fn();
  function Departure() {
    const draft = useReviewDraft();
    return createElement("button", { type: "button", onClick: () => draft?.request(departed) }, "leave");
  }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  async function refresh() {
    const page = await DocumentReviewPage({ params: Promise.resolve(target), searchParams: Promise.resolve({}) });
    const editor = correctionElement(page);
    if (!editor) throw new Error("Public review page did not expose its manual editor");
    flushSync(() => root!.render(createElement(ReviewGuard, null, editor, createElement(Departure))));
  }
  let actionFinished!: () => void;
  const finished = new Promise<void>(resolve => { actionFinished = resolve; });
  boundary.save.mockImplementation(async (_state: unknown, values: FormData) => {
    const saved = await correctDocument(owner.client, { ...target,
      basedOnVersion: Number(values.get("basedOnVersion")), payload: { ...SAMPLE_EXTRACTION,
        documentNumber: String(values.get("documentNumber")),
        claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
      },
    });
    if (!saved.ok) throw new Error(saved.error);
    // Apply the action's new server page before its useActionState receipt settles.
    await refresh();
    actionFinished();
    return { error: null, values: {}, savedVersion: saved.value.version };
  });
  await act(refresh);
  const number = container.querySelector<HTMLInputElement>('input[name="documentNumber"]')!;
  const date = container.querySelector<HTMLInputElement>('[data-source-field="taxPointDate"] input[type="text"]')!;
  await act(async () => {
    number.value = "RECOVERED-FIRST-SAVE"; number.dispatchEvent(new Event("input", { bubbles: true }));
    date.value = "01.10.2026"; date.dispatchEvent(new Event("input", { bubbles: true }));
    [...container!.querySelectorAll("button")].find(button => button.textContent === "leave")!.click();
  });
  const dialog = container.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  await act(async () => {
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "save")!.click();
    await finished;
  });
  expect(boundary.save).toHaveBeenCalledOnce();
  const versions = await listExtractionVersions(owner.client, owner.companyId, reviewedDocument.id);
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ version: 1, author: { kind: "user", userId: owner.userId }, payload: { documentNumber: "RECOVERED-FIRST-SAVE" } });
  expect(departed).toHaveBeenCalledOnce();
  expect(dialog.open).toBe(false);
});
