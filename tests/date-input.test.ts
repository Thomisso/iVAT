// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { DateInput, type DateInputProps } from "@/components/date-input";

let container: HTMLDivElement;
let root: Root;

async function render(defaultValue?: string, props: Partial<DateInputProps> = {}): Promise<HTMLFormElement> {
  await act(async () =>
    root.render(
      createElement(
        "form",
        null,
        createElement(DateInput, { label: "Tax Point Date", name: "taxPointDate", defaultValue, ...props }),
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

function calendarInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[type="date"]')!;
}

async function chooseDate(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(calendarInput(), value);
    calendarInput().dispatchEvent(new Event("input", { bubbles: true }));
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
  it("offers a calendar alongside Czech entry and synchronizes either selection with submission", async () => {
    const form = await render("2026-03-05");
    const calendar = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(calendar).not.toBeNull();
    expect(calendar?.value).toBe("2026-03-05");
    await chooseDate("2026-04-07");
    expect(visibleInput().value).toBe("07.04.2026");
    expect(new FormData(form).get("taxPointDate")).toBe("2026-04-07");
    await type("8.5.2026");
    expect(calendar?.value).toBe("2026-05-08");
    expect(new FormData(form).getAll("taxPointDate")).toEqual(["2026-05-08"]);
  });
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

  it("omits redundant format hints, preserves meaningful instructions and keeps the full keyboard for dots", async () => {
    await render();

    expect(visibleInput().getAttribute("aria-describedby")).toBeNull();
    expect(visibleInput().inputMode).not.toBe("numeric");
    await render(undefined, { hint: "Use the date printed on the Document." });
    expect(container.textContent).toContain("Use the date printed on the Document.");
    expect(visibleInput().getAttribute("aria-describedby")).not.toBeNull();
  });

  it("clears either control and resets text, calendar, submitted value and invalid state together", async () => {
    const form = await render("2026-03-05");
    await type("2026-10-20");
    await blur();
    expect(form.checkValidity()).toBe(false);
    expect(calendarInput().value).toBe("");
    await chooseDate("2026-04-30");
    expect(visibleInput().value).toBe("30.04.2026");
    expect(alert()).toBeNull();
    expect(form.checkValidity()).toBe(true);
    await chooseDate("");
    expect(visibleInput().value).toBe("");
    expect(new FormData(form).get("taxPointDate")).toBe("");
    await type("12.06.2026");
    await act(async () => form.reset());
    expect(visibleInput().value).toBe("05.03.2026");
    expect(calendarInput().value).toBe("2026-03-05");
    expect(new FormData(form).get("taxPointDate")).toBe("2026-03-05");
    expect(form.checkValidity()).toBe(true);
  });

  it("preserves required validation and disables both controls and submission together", async () => {
    let form = await render("2026-03-05", { required: true, disabled: true });
    expect(visibleInput().disabled).toBe(true);
    expect(calendarInput().disabled).toBe(true);
    expect(new FormData(form).has("taxPointDate")).toBe(false);
    expect(form.checkValidity()).toBe(true);
    form = await render("2026-03-05", { required: true });
    await chooseDate("");
    expect(visibleInput().value).toBe("");
    expect(visibleInput().required).toBe(true);
    expect(form.checkValidity()).toBe(false);
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
