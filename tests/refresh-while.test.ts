// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RefreshWhile } from "@/components/refresh-while";

let container: HTMLDivElement;
let root: Root;

async function render(active: boolean): Promise<void> {
  await act(async () => root.render(createElement(RefreshWhile, { active, intervalMs: 100 })));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  router.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("background workflow refresh lifecycle", () => {
  it("polls while processing and stops after successful completion", async () => {
    await render(true);
    await act(async () => vi.advanceTimersByTime(250));
    expect(router.refresh).toHaveBeenCalledTimes(2);

    await render(false);
    await act(async () => vi.advanceTimersByTime(300));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not poll a terminal failure", async () => {
    await render(false);
    await act(async () => vi.advanceTimersByTime(300));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("resumes polling when a processing workspace is reloaded", async () => {
    await render(true);
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(true);
    await act(async () => vi.advanceTimersByTime(100));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("clears polling when navigation unmounts the workspace", async () => {
    await render(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => vi.advanceTimersByTime(300));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
