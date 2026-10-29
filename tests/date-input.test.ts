// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { DateInput } from "@/components/date-input";

let container: HTMLDivElement;
let root: Root;

async function render(defaultValue?: string): Promise<HTMLFormElement> {
  await act(async () =>
    root.render(
      createElement(
        "form",
        null,
        createElement(DateInput, { label: "Tax Point Date", name: "taxPointDate", defaultValue }),
      ),
    ),
  );
  return container.querySelector("form")!;
}

function visibleInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("input:not([type=hidden])")!;
}

async function type(text: string): Promise<void> {
  const input = visibleInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function alert(): Element | null {
  return container.querySelector("[role=alert]");
}

async function blur(): Promise<void> {
  await act(async () => {
    visibleInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DateInput", () => {
  it("shows a stored date as dd.mm.rrrr and submits it as a calendar date", async () => {
    const form = await render("2026-03-05");

    expect(visibleInput().value).toBe("05.03.2026");
    expect(new FormData(form).get("taxPointDate")).toBe("2026-03-05");
  });

  it("submits typed dd.mm.rrrr text as a calendar date", async () => {
    const form = await render();

    await type("7.4.2026");

    expect(new FormData(form).get("taxPointDate")).toBe("2026-04-07");
    expect(form.checkValidity()).toBe(true);
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("shows the expected format as a hint and keeps the full keyboard for the dots", async () => {
    await render();

    expect(container.querySelector(".iv-field-hint")?.textContent).toBe("hint");
    expect(visibleInput().inputMode).not.toBe("numeric");
  });

  it("blocks the form on an invalid date and explains it once the User leaves the field", async () => {
    const form = await render("2026-03-05");

    await type("31.04.2026");

    expect(form.checkValidity()).toBe(false);
    expect(alert()).toBeNull();

    await blur();

    expect(alert()?.textContent).toBe("invalid");
    expect(visibleInput().getAttribute("aria-invalid")).toBe("true");

    await type("30.04.2026");

    expect(alert()).toBeNull();
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).get("taxPointDate")).toBe("2026-04-30");
  });

  it("explains an invalid date when the User submits without leaving the field", async () => {
    const form = await render();

    await type("29.02.2027");
    await act(async () => {
      form.checkValidity();
    });

    expect(alert()?.textContent).toBe("invalid");
  });
});
