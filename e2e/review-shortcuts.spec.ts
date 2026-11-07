import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { browserUserClient } from "../tests/support/e2e";
import { createManualDocument, getDocument, listExtractionVersions } from "../src/application/documents";
import { generateVatReport, finalizeVatReport, getVatReport } from "../src/application/vat-reports";
import { SAMPLE_EXTRACTION } from "../src/ai/fake";
import { fakeVatPayerRegistry } from "../src/vat-registry/fake";

async function setupShortcutReview(page: Page, context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, {
    organizationName: `Shortcuts ${run}`,
    email: `shortcuts-${run}@example.test`,
    password: "Review-shortcuts-browser-230",
  });
  await page.getByLabel("Company name").fill(`Shortcuts ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("12000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  const client = await browserUserClient(await context.cookies());
  const created = await createManualDocument(client, {
    companyId, payload: { ...SAMPLE_EXTRACTION, claimEligibility: { period: "2026-10", origin: "user", confirmed: true } },
  }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();

  return { companyId, client, documentId: created.value.id };
}

test("Company users discover contextual keyboard actions beside notifications on desktop and mobile", async ({ page, context, baseURL }) => {
  const { companyId } = await setupShortcutReview(page, context, baseURL);
  for (const viewport of [{ width: 1366, height: 900 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    const bell = page.getByRole("button", { name: /^Notifications,/ });
    const trigger = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
    await expect(bell).toBeVisible();
    // The first RED must be this missing user-facing trigger, before any
    // shortcut implementation. Geometry establishes actual visual adjacency.
    await expect(trigger).toBeVisible();
    const bellBox = await bell.boundingBox();
    const triggerBox = await trigger.boundingBox();
    if (!bellBox || !triggerBox) throw new Error("visible shell controls need bounds");
    expect(Math.abs(bellBox.y + bellBox.height / 2 - triggerBox.y - triggerBox.height / 2)).toBeLessThanOrEqual(4);
    const gap = Math.max(triggerBox.x - bellBox.x - bellBox.width, bellBox.x - triggerBox.x - triggerBox.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);

    await trigger.focus();
    await page.keyboard.press("Enter");
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    await expect(guide).toBeVisible();
    await expect(guide.getByText("Save draft", { exact: true })).toBeVisible();
    await expect(guide.getByText("Approve", { exact: true })).toBeVisible();
    await expect(guide.getByRole("button", { name: "Close keyboard shortcuts", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(guide.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab");
    await expect(guide.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(guide).toBeHidden();
    await expect(trigger).toBeFocused();
  }

  await page.goto(`/companies/${companyId}`);
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const companyGuide = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(companyGuide).toBeVisible();
  await expect(companyGuide.getByText("Save draft", { exact: true })).toHaveCount(0);
  await expect(companyGuide.getByText("Approve", { exact: true })).toHaveCount(0);
});


test("Ctrl and Cmd save the current draft and approve its current corrections through the review actions", async ({ page, context, baseURL }) => {
  const { companyId, client, documentId } = await setupShortcutReview(page, context, baseURL);
  for (const modifier of ["Control", "Meta"]) {
    let id = documentId;
    if (modifier === "Meta") {
      const created = await createManualDocument(client, { companyId, payload: {
        ...SAMPLE_EXTRACTION, documentNumber: "CMD-INITIAL-230",
        claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
      } }, undefined, fakeVatPayerRegistry());
      if (!created.ok) throw new Error(created.error);
      id = created.value.id;
      await page.goto(`/companies/${companyId}/documents/${id}`);
    }
    const number = page.getByLabel("Document number", { exact: true });
    await number.fill(`DRAFT-${modifier}-230`);
    await number.press(`${modifier}+s`);
    await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeEnabled({ timeout: 3_000 });
    await page.reload();
    await expect(number).toHaveValue(`DRAFT-${modifier}-230`);
    expect((await getDocument(client, companyId, id))?.status).toBe("needs_review");
    expect(await listExtractionVersions(client, companyId, id)).toHaveLength(2);

    await number.fill(`APPROVED-${modifier}-230`);
    await number.press(`${modifier}+Enter`);
    await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
    expect((await getDocument(client, companyId, id))?.status).toBe("approved");
    expect((await listExtractionVersions(client, companyId, id)).map(version => version.payload.documentNumber)).toEqual([
      modifier === "Control" ? "FV-2026-0001" : "CMD-INITIAL-230",
      `DRAFT-${modifier}-230`,
      `APPROVED-${modifier}-230`,
    ]);
  }
});


test("composition keeps review keystrokes in the editor until writing is finished", async ({ page, context, baseURL }) => {
  const { companyId, client, documentId } = await setupShortcutReview(page, context, baseURL);
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("COMPOSING-230");
  await number.dispatchEvent("compositionstart");
  await number.press("Control+s");
  await expect(page.getByRole("button", { name: "Approve version 1", exact: true })).toBeEnabled({ timeout: 3_000 });
  await number.press("Meta+Enter");
  await number.dispatchEvent("compositionend");
  await expect(number).toHaveValue("COMPOSING-230");
  expect((await getDocument(client, companyId, documentId))?.status).toBe("needs_review");
  expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
  await number.press("Control+s");
  await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeEnabled();
  expect((await listExtractionVersions(client, companyId, documentId)).at(-1)?.payload.documentNumber).toBe("COMPOSING-230");
});


test("plain Enter, modal input and pending two-form decisions cannot bypass review guards", async ({ page, context, baseURL }) => {
  const { companyId, client, documentId } = await setupShortcutReview(page, context, baseURL);
  const href = `/companies/${companyId}/documents/${documentId}`;
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("GUARDED-KEYBOARD-230");
  await page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toBeVisible({ timeout: 3_000 });
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Stay here", exact: true }).click();
  await number.press("Enter");
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(help).toBeVisible();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Meta+Enter");
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(number).toHaveValue("GUARDED-KEYBOARD-230");
  expect((await getDocument(client, companyId, documentId))?.status).toBe("needs_review");
  expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);

  await page.getByRole("button", { name: /^Notifications,/ }).click();
  const inbox = page.getByRole("dialog", { name: "Upload notifications", exact: true });
  await expect(inbox).toBeVisible();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  await expect(inbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(number).toHaveValue("GUARDED-KEYBOARD-230");
  await page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
  const departure = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(departure).toBeVisible();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  await expect(departure).toBeVisible();
  await departure.getByRole("button", { name: "Stay here", exact: true }).click();
  expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);

  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  await period.selectOption("2026-11");
  await period.press("Control+Enter");
  const reporting = page.getByRole("dialog", { name: "Unsaved Reporting Period", exact: true });
  await expect(reporting).toBeVisible();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Meta+Enter");
  await expect(reporting).toBeVisible();
  await reporting.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(number).toHaveValue("GUARDED-KEYBOARD-230");
  await expect(period).toHaveValue("2026-11");
  expect((await getDocument(client, companyId, documentId))?.claimedReportingPeriod).toBeNull();

  // Hold the actual first command at the browser transport boundary. Both
  // real form actions still execute with Auth/RLS after the explicit release.
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${href}`, async route => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      posts += 1;
      await gate;
    }
    await route.continue();
  });
  try {
    await number.press("Meta+Enter");
    await expect(reporting).toBeVisible();
    await reporting.getByRole("button", { name: "Save Reporting Period and approve", exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await expect(number).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await page.keyboard.press("Control+s");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Meta+Enter");
    expect(posts).toBe(1);
    expect((await getDocument(client, companyId, documentId))?.status).toBe("needs_review");
    expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  expect(posts).toBe(2);
  expect(await getDocument(client, companyId, documentId)).toMatchObject({ status: "approved", claimedReportingPeriod: "2026-11" });
  expect((await listExtractionVersions(client, companyId, documentId)).map(version => version.payload.documentNumber)).toEqual(["FV-2026-0001", "GUARDED-KEYBOARD-230"]);
  const approvedVersions = await listExtractionVersions(client, companyId, documentId);
  const assertReadOnlyShortcuts = async () => {
    await expect(number).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await expect(help).toBeVisible();
    await expect(help.getByText("Save draft", { exact: true })).toHaveCount(0);
    await expect(help.getByText("Approve", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+s");
    await page.keyboard.press("Meta+Enter");
    expect(await listExtractionVersions(client, companyId, documentId)).toEqual(approvedVersions);
  };

  await page.goto(href);
  await expect(page.getByRole("button", { name: "Return to review", exact: true })).toBeVisible();
  await assertReadOnlyShortcuts();
  // Explicit recorded viewing is readonly even when it selects the latest Version.
  await page.goto(`${href}?version=2`);
  await assertReadOnlyShortcuts();
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await expect(number).toBeEnabled();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(help.getByText("Approve", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByText("Version history", { exact: true }).click();
  await page.getByRole("link", { name: /^Version 1:/ }).click();
  await assertReadOnlyShortcuts();
  expect((await getDocument(client, companyId, documentId))?.status).toBe("needs_review");
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(number).toBeEnabled();
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await number.press("Control+Enter");
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  expect((await generateVatReport(client, { companyId, period: "2026-11" })).ok).toBe(true);
  expect(await finalizeVatReport(client, { companyId, period: "2026-11", confirmed: true })).toEqual({ ok: true, value: null });
  const lockedReport = await getVatReport(client, companyId, "2026-11");
  await page.goto(href);
  await expect(page.getByRole("button", { name: "Return to review", exact: true })).toHaveCount(0);
  await assertReadOnlyShortcuts();
  expect(await getVatReport(client, companyId, "2026-11")).toEqual(lockedReport);
});
