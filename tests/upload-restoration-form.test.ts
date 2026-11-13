// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { File as NativeFile } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { SourceFileUploadForm } from "@/app/companies/[companyId]/source-file-upload-form";
import type { UploadDraftStorage } from "@/lib/upload-draft-storage";
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("next-intl", () => ({ useTranslations: () => Object.assign((key: string) => key, { has: () => true }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); vi.unstubAllGlobals(); navigation.push.mockReset(); });
const limits = { maxFileBytes: 1024, maxFilePages: 10, maxBatchFiles: 5 };
async function mount(storage: UploadDraftStorage, userId = "owner", maxFileBytes = limits.maxFileBytes) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => { root!.render(createElement(SourceFileUploadForm, { companyId: "company", userId, limits: { ...limits, maxFileBytes }, storage })); });
}
async function select() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new NativeFile([new Uint8Array([1, 2, 3])], "page.png")] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }

it("uploads and finishes in memory when local persistence is unavailable", async () => {
  const storage: UploadDraftStorage = { async read() { throw new Error("Disabled"); }, async write() { throw new Error("Quota"); } };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/upload-batches")) return Response.json({ ok: true, value: { id: JSON.parse(init.body as string).batchId } });
    if (url.endsWith("/finish")) return Response.json({ ok: true, value: null });
    const body = JSON.parse(init.body as string);
    return Response.json(body.complete ? { ok: true, value: { id: "source" } } : { ok: true, value: { attemptId: "known", confirmedBytes: 3, byteSize: 3, complete: true } });
  });
  vi.stubGlobal("crypto", webcrypto);
  await mount(storage);
  await select();
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("page.png"); });
  expect(container.textContent).toContain("localDraftUnavailable");
  await submit();
  expect(requests.some(url => url.endsWith("/finish"))).toBe(true);
  expect(navigation.push).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("upload_failed");
});

it("requires matching bytes for a restored item and sends its pinned identity and attempt", async () => {
  const draft = { batchId: "batch", items: [{ id: "source", fileName: "original.png", byteSize: 3,
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", kind: "picker",
    progress: 99, confirmedBytes: 3, status: "uploading", error: null, retryable: true, attemptId: "attempt-A", groupId: "group" }] };
  const storage: UploadDraftStorage = { async read() { return draft; }, async write() {} };
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    if (body) bodies.push(body);
    if (url.endsWith("/upload-batches")) return Response.json({ ok: true, value: { id: "batch" } });
    if (url.endsWith("/finish")) return Response.json({ ok: true, value: null });
    return Response.json(body.complete ? { ok: true, value: { id: "source" } } : { ok: true, value: { attemptId: "attempt-A", confirmedBytes: 3, byteSize: 3, complete: true } });
  });
  await mount(storage);
  expect(container.textContent).toContain("upload_file_required");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="reselectFile"]');
  expect(input).not.toBeNull();
  const choose = async (bytes: number[], name: string) => {
    Object.defineProperty(input!, "files", { configurable: true, value: [new NativeFile([new Uint8Array(bytes)], name)] });
    await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  await choose([3, 2, 1], "original.png");
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("upload_checksum_mismatch"); });
  expect(bodies).toEqual([]);
  await choose([1, 2, 3], "renamed.png");
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).not.toContain("upload_checksum_mismatch"); });
  await submit();
  expect(bodies.filter(body => body.sha256)).toEqual([
    { batchId: "batch", fileName: "original.png", byteSize: 3, sha256: draft.items[0].sha256, complete: false, expectedAttemptId: "attempt-A" },
    { batchId: "batch", fileName: "original.png", byteSize: 3, sha256: draft.items[0].sha256, complete: true, expectedAttemptId: "attempt-A" },
  ]);
  expect(navigation.push).toHaveBeenCalledOnce();
});

it("does not restore or save a late account's read after a scope change", async () => {
  let release!: (value: unknown) => void;
  const writes: { key: string; draft: unknown }[] = [];
  const storage: UploadDraftStorage = {
    read: key => key.includes("user:old:") ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null),
    async write(key, draft) { writes.push({ key, draft }); },
  };
  await mount(storage, "old");
  await mount(storage, "new");
  await act(async () => { release({ batchId: "private-batch", items: [{ id: "old-source", fileName: "private.png", byteSize: 3,
    sha256: "a".repeat(64), kind: "picker", progress: 0, confirmedBytes: 0, status: "queued", error: null, retryable: true }] }); });
  expect(container.textContent).not.toContain("private.png");
  expect(writes.filter(({ draft }) => draft !== null)).toEqual([]);
});

it("drops a late file hash after disposal and keeps the replacement account's queue empty", async () => {
  let release!: (bytes: ArrayBuffer) => void;
  const writes: unknown[] = [];
  const storage: UploadDraftStorage = { async read() { return null; }, async write(_key, draft) { writes.push(draft); } };
  vi.stubGlobal("crypto", { randomUUID: () => "source", subtle: { digest: () => new Promise(resolve => { release = resolve; }) } });
  await mount(storage, "old");
  await select();
  await mount(storage, "new");
  await act(async () => release(new Uint8Array(32).buffer));
  expect(container.textContent).not.toContain("page.png");
  expect(writes.filter(value => value !== null)).toEqual([]);
});

it("pins an attempt across an automatic network retry instead of adopting the replacement", async () => {
  const storage: UploadDraftStorage = { async read() { return null; }, async write() {} };
  const bodies: Record<string, unknown>[] = [];
  class FailedRequest extends EventTarget {
    upload = new EventTarget(); response = null; status = 0; responseURL = "";
    open() {} setRequestHeader() {} abort() { this.dispatchEvent(new Event("abort")); }
    send() { this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("loadend")); }
  }
  vi.stubGlobal("XMLHttpRequest", FailedRequest);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/upload-batches")) return Response.json({ ok: true, value: { id: "batch" } });
    bodies.push(body);
    return Response.json(bodies.length === 1
      ? { ok: true, value: { attemptId: "attempt-A", confirmedBytes: 0, byteSize: 3, complete: false } }
      : { ok: false, error: "upload_attempt_changed" }, { status: bodies.length === 1 ? 200 : 409 });
  });
  await mount(storage);
  await select();
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("page.png"); });
  await submit();
  expect(bodies.map(body => body.expectedAttemptId)).toEqual([undefined, "attempt-A"]);
  expect(container.textContent).toContain("upload_attempt_changed");
  expect(navigation.push).not.toHaveBeenCalled();
});

it("does not navigate an account after a late draft deletion finishes in a replaced scope", async () => {
  let finished = false;
  let release: (() => void) | undefined;
  const storage: UploadDraftStorage = { async read() { return null; }, async write(_key, draft) {
    if (finished && draft === null && !release) await new Promise<void>(resolve => { release = resolve; });
  } };
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/upload-batches")) return Response.json({ ok: true, value: { id: "batch" } });
    if (url.endsWith("/finish")) { finished = true; return Response.json({ ok: true, value: null }); }
    return Response.json(JSON.parse(init.body as string).complete ? { ok: true, value: { id: "source" } } : { ok: true, value: { attemptId: "attempt", confirmedBytes: 3, byteSize: 3, complete: true } });
  });
  await mount(storage, "old"); await select();
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("page.png"); });
  await submit();
  expect(release).toBeDefined();
  await mount(storage, "new");
  await act(async () => release!());
  expect(navigation.push).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("page.png");
});

it("distinguishes expired authentication from unavailable local storage at Batch admission", async () => {
  const storage: UploadDraftStorage = { async read() { return null; }, async write() { throw new Error("Quota"); } };
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async () => new Response("Sign in again", { status: 401 }));
  await mount(storage); await select();
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("page.png"); });
  await submit();
  expect(container.textContent).toContain("upload_authentication_required");
  expect(container.textContent).not.toContain("upload_failed");
});


it("reconciles an already completed original before applying lower current upload limits", async () => {
  const storage: UploadDraftStorage = { async read() { return null; }, async write() {} };
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/upload-batches")) return Response.json({ ok: true, value: { id: "batch" } });
    if (url.endsWith("/finish")) return Response.json({ ok: true, value: null });
    return Response.json(JSON.parse(init.body as string).complete ? { ok: true, value: { id: "source" } } : { ok: true, value: { attemptId: "attempt", confirmedBytes: 3, byteSize: 3, complete: true } });
  });
  await mount(storage, "owner", 1); await select();
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("page.png"); });
  await submit();
  expect(navigation.push).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("file_too_large");
});

it("resumes a known started Batch without re-admitting its frozen manifest under changed limits", async () => {
  const file = new NativeFile([new Uint8Array([1, 2, 3])], "original.png");
  const saved = { batchId: "batch", items: [{ id: "source", file, fileName: "original.png", byteSize: 3, kind: "picker",
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", attemptId: "attempt-A", status: "uploaded", progress: 100, confirmedBytes: 3, retryable: false, error: null }] };
  const storage: UploadDraftStorage = { async read() { return saved; }, async write() {} };
  const paths: string[] = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    paths.push(url);
    if (url.endsWith("/upload-batches")) return Response.json({ ok: false, error: "too_many_files" }, { status: 400 });
    if (url.endsWith("/finish")) return Response.json({ ok: true, value: null });
    return Response.json(JSON.parse(init.body as string).complete ? { ok: true, value: { id: "source" } } : { ok: true, value: { attemptId: "attempt-A", confirmedBytes: 3, byteSize: 3, complete: true } });
  });
  await mount(storage);
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("original.png"); });
  await submit();
  expect(paths.some(path => path.endsWith("/upload-batches"))).toBe(false);
  expect(navigation.push).toHaveBeenCalledOnce();
});
