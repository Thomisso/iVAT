import { expect, test } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { browserUserClient, addBrowserSourceEvidenceFixture } from "../tests/support/e2e";
import { SAMPLE_EXTRACTION } from "../src/ai/fake";
import { correctDocument, createManualDocument, getDocument, listExtractionVersions } from "../src/application/documents";
import { generateVatReport, finalizeVatReport, getVatReport } from "../src/application/vat-reports";
import { fakeVatPayerRegistry } from "../src/vat-registry/fake";

test("a pending approval protects the draft until refusal, then permits a deliberate correction", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `Review ${run}`, email: `review-${run}@example.test`, password: "Review-workspace-browser-229" });
  await page.getByLabel("Company name").fill(`Review ${run}`);
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
    companyId, payload: { ...SAMPLE_EXTRACTION, documentType: null },
  }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  const type = page.getByLabel("Document type", { exact: true });
  const number = page.getByLabel("Document number", { exact: true });
  const approve = page.getByRole("button", { name: "Approve version 1", exact: true });
  await number.fill("PENDING-SUBMITTED-229");

  // Pause transport at the browser boundary, without replacing the real action
  // or its eventual Auth/RLS result. No timing sleep controls this interleaving.
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${href}`, async route => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await approve.click();
    await expect.poll(() => held).toBe(true);
    await expect(approve).toBeDisabled();
    await expect(type).toBeDisabled({ timeout: 3_000 });
    await expect(number).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByLabel("Tax point date", { exact: true })).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByRole("checkbox", { name: "Claim selected supplies", exact: true })).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: "Add rate", exact: true })).toBeDisabled({ timeout: 3_000 });
  } finally {
    release();
  }
  await expect(page.locator('.correction-form .iv-notice-danger[role="alert"]')).toContainText("Choose a Document type before confirming claim eligibility.");
  await expect(approve).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(type).toHaveValue("");
  await expect(number).toHaveValue("PENDING-SUBMITTED-229");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);

  await type.selectOption("invoice");
  await number.fill("AFTER-REFUSAL-229");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeEnabled();
  await expect(type).toHaveValue("invoice");
  await expect(number).toHaveValue("AFTER-REFUSAL-229");
  expect((await listExtractionVersions(client, companyId, created.value.id)).map(version => ({
    type: version.payload.documentType, number: version.payload.documentNumber,
  }))).toEqual([
    { type: null, number: "FV-2026-0001" },
    { type: "invoice", number: "AFTER-REFUSAL-229" },
  ]);
});


test("dirty history navigation offers stay, failed save and discard without losing the draft", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `Departure ${run}`, email: `departure-${run}@example.test`, password: "Review-departure-browser-229" });
  await page.getByLabel("Company name").fill(`Departure ${run}`);
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
  const created = await createManualDocument(client, { companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  const number = page.getByLabel("Document number", { exact: true });
  const date = page.getByLabel("Tax point date", { exact: true });
  await page.getByText("Version history", { exact: true }).click();
  const history = page.getByRole("link", { name: /^Version 1:/ });
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await number.fill("UNSAVED-DEPARTURE-229");
  await history.click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(guard).toBeHidden();
  await expect(number).toHaveValue("UNSAVED-DEPARTURE-229");
  await expect(page).toHaveURL(new RegExp(`${href}$`));

  await date.fill("31.2.2026");
  await date.blur();
  await history.click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(date).toHaveValue("31.2.2026");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(number).toHaveValue("UNSAVED-DEPARTURE-229");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);
  // A failed save leaves the departure unresolved; closing it never discards.
  await page.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(page.getByRole("region", { name: "Errors to correct", exact: true }).getByRole("button", { name: /Tax point date: Enter a valid date/ })).toBeVisible({ timeout: 3_000 });
  await date.fill("1.10.2026");
  await history.click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${href}\?.*version=1`));
  await expect(number).toBeDisabled();
  await expect(number).toHaveValue("FV-2026-0001");
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions.map(version => version.payload.documentNumber)).toEqual(["FV-2026-0001", "UNSAVED-DEPARTURE-229"]);
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(number).toHaveValue("UNSAVED-DEPARTURE-229");
  await number.fill("DISCARD-DEPARTURE-229");
  await page.getByText("Version history", { exact: true }).click();
  await page.getByRole("link", { name: /^Version 1:/ }).click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${href}\?.*version=1`));
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(2);
});


test("the laptop comparison desk resizes and scrolls independently while mobile and error links retain values", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `Desk ${run}`, email: `desk-${run}@example.test`, password: "Review-desk-browser-229" });
  await page.getByLabel("Company name").fill(`Desk ${run}`);
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
  const documentId = await addBrowserSourceEvidenceFixture({ companyId, cookies: await context.cookies() });
  const original = (await listExtractionVersions(client, companyId, documentId))[0];
  const corrected = await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: { ...original.payload, customer: { ...original.payload.customer, ico: "123" } } }, undefined, fakeVatPayerRegistry());
  expect(corrected.ok).toBe(true);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  await expect(page.locator(".pdf-source-page > canvas")).toHaveAttribute("data-ready", "true");
  const separator = page.getByRole("separator", { name: "Resize source and data panels", exact: true });
  await expect(separator).toBeVisible({ timeout: 3_000 });
  const source = page.getByRole("region", { name: "Source File", exact: true });
  const data = page.getByRole("region", { name: "Document data", exact: true });
  const initialWidth = (await source.boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  expect((await source.boundingBox())!.width).toBeGreaterThan(initialWidth);
  const amount = page.getByRole("group", { name: "Rate breakdown and totals", exact: true });
  const supplier = page.getByRole("group", { name: "Supplier", exact: true });
  expect(await amount.evaluate((element, other) => !!(element.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await supplier.elementHandle())).toBe(true);
  const beforeSource = await source.evaluate(element => element.scrollTop);
  await data.evaluate(element => { element.scrollTop = 500; });
  expect(await data.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await source.evaluate(element => element.scrollTop)).toBe(beforeSource);
  const actions = page.getByRole("group", { name: "Document decisions", exact: true });
  await expect(actions.getByRole("button", { name: "Approve version 2", exact: true })).toBeInViewport();
  await expect(actions.getByRole("button", { name: "Reject", exact: true })).toBeInViewport();
  await expect(actions.getByRole("button", { name: "Save draft", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("review-desk-1366.png") });
  const error = page.getByRole("region", { name: "Errors to correct", exact: true }).getByRole("button", { name: /Customer.*IČO/ });
  await error.click();
  await expect(page.getByRole("group", { name: "Customer", exact: true }).getByLabel("IČO", { exact: true })).toBeFocused();
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("MOBILE-KEEPS-229");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show Source File", exact: true }).click();
  await expect(source).toBeVisible();
  await expect(data).toBeHidden();
  await page.getByRole("button", { name: "Show document data", exact: true }).click();
  await expect(number).toHaveValue("MOBILE-KEEPS-229");
  await expect(actions.getByRole("button", { name: "Approve version 2", exact: true })).toBeInViewport();
  await expect(actions.getByRole("button", { name: "Save draft", exact: true })).toBeInViewport();
  const actionBox = (await actions.boundingBox())!;
  const navBox = (await page.getByRole("navigation", { name: "Company navigation", exact: true }).boundingBox())!;
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navBox.y);
  await page.screenshot({ path: testInfo.outputPath("review-desk-mobile.png") });
});


test("reasoned rejection follows the filtered queue and history, restore and locks keep their allowed actions", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `Decisions ${run}`, email: `decisions-${run}@example.test`, password: "Review-decisions-browser-229" });
  await page.getByLabel("Company name").fill(`Decisions ${run}`);
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
  const ids: string[] = [];
  for (const documentNumber of ["QUEUE-A-229", "QUEUE-B-229"]) {
    const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber } }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    ids.push(created.value.id);
  }
  await page.goto(`/companies/${companyId}/documents?view=outgoing&status=needs_review`);
  await page.getByRole("table", { name: "Documents", exact: true }).getByRole("link").first().click();
  await expect(page.getByText("Document 1 of 2", { exact: true })).toBeVisible();
  const rejectedId = new URL(page.url()).pathname.split("/").at(-1)!;
  const rejectedHref = `/companies/${companyId}/documents/${rejectedId}`;
  await page.getByLabel("Document number", { exact: true }).fill("DO-NOT-SAVE-REJECTION-229");
  const reject = page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true });
  await reject.click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject", exact: true });
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  await expect(dialog.getByLabel("Exclusion reason", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(reject).toBeFocused();
  await reject.click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  expect(await dialog.getByLabel("Exclusion reason", { exact: true }).evaluate((element: HTMLTextAreaElement) => element.validity.valueMissing)).toBe(true);
  await expect(page.getByText("Document 1 of 2", { exact: true })).toBeVisible();
  await dialog.getByLabel("Exclusion reason", { exact: true }).fill("Not a business Document");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Document 1 of 1", { exact: true })).toBeVisible();
  expect((await getDocument(client, companyId, rejectedId))?.status).toBe("rejected");
  expect(await listExtractionVersions(client, companyId, rejectedId)).toHaveLength(1);
  const approvedId = ids.find(id => id !== rejectedId)!;
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents` && url.searchParams.get("view") === "outgoing" && url.searchParams.get("status") === "needs_review");
  await expect(page.getByText("No documents match the filters.", { exact: true })).toBeVisible();
  const approvedHref = `/companies/${companyId}/documents/${approvedId}`;
  await page.goto(`${approvedHref}?version=1`);
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
  for (const name of ["Return to review", "Reject", "Save draft", "Check payment account again"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(page.getByRole("button", { name: "Return to review", exact: true })).toBeVisible();
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  expect(await finalizeVatReport(client, { companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  await page.reload();
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Return to review", exact: true })).toHaveCount(0);
  const lockedReport = await getVatReport(client, companyId, "2026-10");
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check payment account again", exact: true })).toBeEnabled();
  expect(await getVatReport(client, companyId, "2026-10")).toEqual(lockedReport);
  expect((await getDocument(client, companyId, approvedId))?.status).toBe("approved");
  expect(await listExtractionVersions(client, companyId, approvedId)).toHaveLength(1);
  // A separate period keeps restore independent of the finalized October.
  const restored = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber: "DIRECT-RESTORE-229", taxPointDate: "2026-11-01" } }, undefined, fakeVatPayerRegistry());
  if (!restored.ok) throw new Error(restored.error);
  await page.goto(`/companies/${companyId}/documents/${restored.value.id}`);
  await expect(page.getByText(/Document \d+ of \d+/, { exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
  await dialog.getByLabel("Exclusion reason", { exact: true }).fill("Direct entry exclusion");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  await page.goto(`/companies/${companyId}/documents/${restored.value.id}`);
  await page.getByRole("button", { name: "Reverse exclusion", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version 1", exact: true })).toBeVisible();
  expect((await getDocument(client, companyId, restored.value.id))?.status).toBe("needs_review");
  expect(await listExtractionVersions(client, companyId, restored.value.id)).toHaveLength(1);
  // Direct entry never silently opens the other rejected queue Document.
  expect(new URL(page.url()).pathname).not.toBe(rejectedHref);
});
