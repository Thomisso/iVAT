import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { browserUserClient, addBrowserSourceEvidenceFixture } from "../tests/support/e2e";
import { SAMPLE_EXTRACTION } from "../src/ai/fake";
import { correctDocument, createManualDocument, getDocument, listExtractionVersions, updateDocumentReporting, approveDocument } from "../src/application/documents";
import { generateVatReport, finalizeVatReport, getVatReport, unlockReportingPeriod } from "../src/application/vat-reports";
import { fakeVatPayerRegistry } from "../src/vat-registry/fake";

async function setupReviewCompany(page: Page, context: BrowserContext, baseURL: string | undefined, scenario: string) {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `${scenario} ${run}`, email: `${scenario.toLowerCase()}-${run}@example.test`, password: "Review-workspace-browser-229" });
  await page.getByLabel("Company name").fill(`${scenario} ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("12000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  return {
    companyId: new URL(page.url()).pathname.split("/")[2],
    client: await browserUserClient(await context.cookies()),
  };
}

test("a pending approval protects the draft until refusal, then permits a deliberate correction", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "Review");
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
    await expect(page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true })).toBeDisabled({ timeout: 3_000 });
    await expect(type).toBeDisabled({ timeout: 3_000 });
    await expect(number).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByLabel("Tax point date", { exact: true })).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByRole("checkbox", { name: "Claim selected supplies", exact: true })).toBeDisabled({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: "Add rate", exact: true })).toBeDisabled({ timeout: 3_000 });
    await page.getByRole("navigation", { name: "Company navigation", exact: true }).getByRole("link", { name: "Documents", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator('.correction-form .iv-notice-danger[role="alert"]')).toContainText("Choose a Document type before confirming claim eligibility.");
  await expect(approve).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(type).toHaveValue("");
  await expect(number).toHaveValue("PENDING-SUBMITTED-229");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);
  const acceptedRequest = await page.locator('input[name="requestId"]').inputValue();
  await page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Reject", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(number).toHaveValue("FV-2026-0001");
  await expect(type).toHaveValue("");
  await expect(page.locator('input[name="requestId"]')).toHaveValue(acceptedRequest);
  await expect(page.locator('input[name="basedOnVersion"]')).toHaveValue("1");
  await expect(page.locator('input[name="acknowledgement"]')).toHaveValue("");

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
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "Departure");
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
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "Desk");
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
  await page.locator('[data-source-region="documentNumber"]').click();
  await expect(number).toBeFocused({ timeout: 3_000 });
  await expect(data).toBeVisible();
  await page.getByRole("button", { name: "Show document data", exact: true }).click();
  await expect(number).toHaveValue("MOBILE-KEEPS-229");
  await expect(actions.getByRole("button", { name: "Approve version 2", exact: true })).toBeInViewport();
  await expect(actions.getByRole("button", { name: "Save draft", exact: true })).toBeInViewport();
  const actionBox = (await actions.boundingBox())!;
  const navBox = (await page.getByRole("navigation", { name: "Company navigation", exact: true }).boundingBox())!;
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navBox.y);
  await page.screenshot({ path: testInfo.outputPath("review-desk-mobile.png") });
  const mountedSource = await page.locator(".pdf-source-page > canvas").elementHandle();
  const acceptedBase = await page.locator('input[name="basedOnVersion"]').inputValue();
  const acceptedRequest = await page.locator('input[name="requestId"]').inputValue();
  await actions.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Reject", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(number).toHaveValue("PDF-EVIDENCE");
  expect(await mountedSource!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator('input[name="basedOnVersion"]')).toHaveValue(acceptedBase);
  await expect(page.locator('input[name="requestId"]')).toHaveValue(acceptedRequest);
  await number.fill("MOBILE-KEEPS-229");
  await page.getByText("AI and other actions", { exact: true }).click();
  await page.getByRole("checkbox", { name: /I understand that AI will replace/ }).check();
  await page.getByRole("button", { name: "Run AI replacement", exact: true }).click();
  const departure = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(departure).toBeVisible({ timeout: 3_000 });
  await departure.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(number).toHaveValue("MOBILE-KEEPS-229");
  expect((await getDocument(client, companyId, documentId))?.status).toBe("needs_review");
  expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(2);
  let browserWarning = "";
  page.once("dialog", async warning => { browserWarning = warning.type(); await warning.dismiss(); });
  await page.reload({ timeout: 3_000 }).catch(error => { if (!browserWarning) throw error; });
  expect(browserWarning).toBe("beforeunload");
  await expect(number).toHaveValue("MOBILE-KEEPS-229");
});


test("reasoned rejection follows the filtered queue and history, restore and locks keep their allowed actions", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "Decisions");
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
  await page.getByLabel("Direction", { exact: true }).selectOption("incoming");
  await page.getByRole("checkbox", { name: "Claim selected supplies", exact: true }).check();
  await page.getByLabel("Claimed net", { exact: true }).fill("123");
  await page.getByLabel("Tax point date", { exact: true }).fill("31.2.2026");
  await page.getByLabel("Tax point date", { exact: true }).blur();
  const reject = page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true });
  await reject.click();
  await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject", exact: true });
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  await expect(dialog.getByLabel("Exclusion reason", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(reject).toBeFocused();
  // Discard resolves the draft even when the next intent is only a dialog.
  // Cancelling rejection must not resurrect the discarded accounting edit.
  await expect(page.getByLabel("Document number", { exact: true })).toHaveValue(rejectedId === ids[0] ? "QUEUE-A-229" : "QUEUE-B-229", { timeout: 3_000 });
  expect(await listExtractionVersions(client, companyId, rejectedId)).toHaveLength(1);
  await expect(page.getByLabel("Direction", { exact: true })).toHaveValue("outgoing");
  await expect(page.getByRole("checkbox", { name: "Claim selected supplies", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Tax point date", { exact: true })).toHaveValue("01.10.2026");
  await reject.click();
  await expect(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toHaveCount(0);
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
  const approvedVersions = await listExtractionVersions(client, companyId, approvedId);
  expect(approvedVersions.map(version => version.version)).toEqual([1, 2]);
  expect(approvedVersions[1].payload.counterpartyLink?.recorded).toMatchObject({ name: "Novák s.r.o.", ico: "25596641" });
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
  expect(await listExtractionVersions(client, companyId, approvedId)).toEqual(approvedVersions);
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


for (const direction of ["Back", "Forward"] as const) {
  test(`browser ${direction} offers Stay without replacing the mounted draft or source`, async ({ page, context, baseURL }) => {
    const { companyId, client } = await setupReviewCompany(page, context, baseURL, `History${direction}`);
    await addBrowserSourceEvidenceFixture({ companyId, cookies: await context.cookies() });
    await page.goto(`/companies/${companyId}/documents?status=needs_review`);
    await page.getByRole("table", { name: "Documents", exact: true }).getByRole("link").first().click();
    await expect(page.locator(".pdf-source-page > canvas")).toHaveAttribute("data-ready", "true");
    const firstHref = page.url();
    await page.getByRole("link", { name: "Next →", exact: true }).click();
    await expect(page).not.toHaveURL(firstHref);
    await expect(page.locator('form.correction-form input[name="documentId"]')).toHaveValue(new URL(page.url()).pathname.split("/").at(-1)!);
    await expect(page.locator(".pdf-source-page > canvas")).toHaveAttribute("data-ready", "true");
    const secondHref = page.url();
    if (direction === "Forward") {
      await page.goBack({ waitUntil: "commit" });
      await expect(page).toHaveURL(firstHref);
      await expect(page.locator(".pdf-source-page > canvas")).toHaveAttribute("data-ready", "true");
    }
    const href = page.url();
    const documentId = new URL(href).pathname.split("/").at(-1)!;
    await expect(page.locator('form.correction-form input[name="documentId"]')).toHaveValue(documentId);
    const number = page.getByLabel("Document number", { exact: true });
    const form = await page.locator("form.correction-form").elementHandle();
    const source = await page.locator(".pdf-source-page > canvas").elementHandle();
    const base = await page.locator('input[name="basedOnVersion"]').inputValue();
    await number.fill(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);

    // Real browser traversal, through history created by App Router links.
    // A synthetic popstate would not exercise the browser's entry ordering.
    if (direction === "Back") await page.goBack({ waitUntil: "commit" });
    else await page.goForward({ waitUntil: "commit" });
    const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
    await expect(guard).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveURL(href);
    expect(await form!.evaluate(element => element.isConnected)).toBe(true);
    expect(await source!.evaluate(element => element.isConnected)).toBe(true);
    await expect(page.locator('input[name="basedOnVersion"]')).toHaveValue(base);
    await guard.getByRole("button", { name: "Stay here", exact: true }).click();
    await expect(number).toHaveValue(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);
    await expect(page).toHaveURL(href);
    expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
    // Rapid native requests may coalesce; either way the original draft stays.
    await page.evaluate(forward => { if (forward) { history.forward(); history.forward(); } else { history.back(); history.back(); } }, direction === "Forward");
    await expect(guard).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveURL(href);
    expect(await form!.evaluate(element => element.isConnected)).toBe(true);
    await guard.getByRole("button", { name: "Stay here", exact: true }).click();
    await expect(number).toHaveValue(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);

    const date = page.getByLabel("Tax point date", { exact: true });
    await date.fill("31.2.2026");
    await date.blur();
    if (direction === "Back") await page.goBack({ waitUntil: "commit" });
    else await page.goForward({ waitUntil: "commit" });
    await expect(guard).toBeVisible({ timeout: 3_000 });
    await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
    await expect(date).toHaveValue("31.2.2026");
    await expect(date).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(href);
    expect(await form!.evaluate(element => element.isConnected)).toBe(true);
    expect(await source!.evaluate(element => element.isConnected)).toBe(true);
    expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
    await guard.getByRole("button", { name: "Stay here", exact: true }).click();
    await date.fill("1.10.2026");
    if (direction === "Back") await page.goBack({ waitUntil: "commit" });
    else await page.goForward({ waitUntil: "commit" });
    await expect(guard).toBeVisible({ timeout: 3_000 });

    let held = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/documents/${documentId}**`, async route => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    try {
      await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
      await expect.poll(() => held).toBe(true);
      await expect(number).toBeDisabled();
      // A second real traversal while saving restores the source without
      // replacing the original save-and-continue destination.
      if (direction === "Back") await page.goBack({ waitUntil: "commit" });
      else await page.goForward({ waitUntil: "commit" });
      await expect(page).toHaveURL(href);
      await expect(number).toHaveValue(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);
      await expect(guard.getByRole("button", { name: "Discard changes", exact: true })).toBeDisabled();
    } finally { release(); }
    await expect(page).toHaveURL(direction === "Back" ? firstHref : secondHref);
    expect((await listExtractionVersions(client, companyId, documentId))[1].payload.documentNumber).toBe(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);
    if (direction === "Back") await page.goForward({ waitUntil: "commit" });
    else await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(href);
    await expect(page.locator('form.correction-form input[name="documentId"]')).toHaveValue(documentId);
    await expect(number).toHaveValue(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);
    await number.fill(`DISCARD-${direction.toUpperCase()}-229`);
    // A history-menu jump is real traversal too; a later request wins.
    if (direction === "Back") await page.evaluate(() => history.go(-2));
    else await page.goForward({ waitUntil: "commit" });
    await expect(guard).toBeVisible({ timeout: 3_000 });
    if (direction === "Back") await page.goBack({ waitUntil: "commit" });
    else await page.goForward({ waitUntil: "commit" });
    await expect(page).toHaveURL(href);
    await expect(number).toHaveValue(`DISCARD-${direction.toUpperCase()}-229`);
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page).toHaveURL(direction === "Back" ? firstHref : secondHref);
    // Compensation and replay must retain the original opposite history entry.
    if (direction === "Back") await page.goForward({ waitUntil: "commit" });
    else await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(href);
    await expect(guard).toHaveCount(0);
    await expect(number).toHaveValue(`BROWSER-${direction.toUpperCase()}-DRAFT-229`);
    if (direction === "Back") {
      // Same URL, different entries: identity must not be inferred from href.
      await page.getByText("Version history", { exact: true }).click();
      await page.getByRole("link", { name: /^Version 1:/ }).click();
      await expect(number).toBeDisabled();
      await page.getByRole("link", { name: "Show the current version", exact: true }).click();
      await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeEnabled();
      await expect(page).toHaveURL(href);
      const entry = await page.evaluate(() => (window as Window & { navigation?: { currentEntry: { key: string } } }).navigation!.currentEntry.key);
      const sameUrlForm = await page.locator("form.correction-form").elementHandle();
      await number.fill("SAME-URL-DRAFT-229");
      await page.evaluate(() => history.go(-2));
      await expect(guard).toBeVisible({ timeout: 3_000 });
      await expect(page).toHaveURL(href);
      expect(await page.evaluate(() => (window as Window & { navigation?: { currentEntry: { key: string } } }).navigation!.currentEntry.key)).toBe(entry);
      expect(await sameUrlForm!.evaluate(element => element.isConnected)).toBe(true);
      await guard.getByRole("button", { name: "Stay here", exact: true }).click();
      await expect(number).toHaveValue("SAME-URL-DRAFT-229");
    }
  });
}


test("the mobile Partial Claim error summary focuses the visible selection control", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "PartialFocus");
  const created = await createManualDocument(client, { companyId, payload: {
    ...SAMPLE_EXTRACTION,
    partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "999999.00", vatAmount: "209999.79" }] },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  const summary = page.getByRole("region", { name: "Errors to correct", exact: true });
  await summary.getByRole("button", { name: /^Partial Claim:/ }).click();
  const selection = page.getByRole("checkbox", { name: "Claim selected supplies", exact: true });
  await expect(selection).toBeFocused({ timeout: 3_000 });
  await expect(selection).toBeInViewport();
  await expect(page.getByRole("region", { name: "Document data", exact: true })).toBeVisible();
  await expect(selection).toBeChecked();
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);
  await page.getByText("Version history", { exact: true }).click();
  await page.getByRole("link", { name: /^Version 1:/ }).click();
  await expect(selection).toBeDisabled();
  await summary.getByRole("button", { name: /^Partial Claim:/ }).click();
  await expect(page.getByRole("group", { name: "Partial Claim", exact: true })).toBeFocused();
});


test("without Navigation API review history uses the native warning and preserves Forward", async ({ page, context, baseURL }) => {
  await context.addInitScript(() => { Object.defineProperty(window, "navigation", { configurable: true, value: undefined }); });
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "NativeHistory");
  for (const documentNumber of ["NATIVE-A-229", "NATIVE-B-229"]) {
    const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber } }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
  }
  await page.goto(`/companies/${companyId}/documents?view=outgoing&status=needs_review`);
  await page.getByRole("table", { name: "Documents", exact: true }).getByRole("link").first().click();
  const firstHref = page.url();
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await page.getByRole("link", { name: "Next →", exact: true }).click();
  await expect(page).not.toHaveURL(firstHref);
  const href = page.url();
  const documentId = new URL(href).pathname.split("/").at(-1)!;
  await expect(page.locator('form.correction-form input[name="documentId"]')).toHaveValue(documentId);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const number = page.getByLabel("Document number", { exact: true });
  await number.click();
  expect(await page.evaluate(() => navigator.userActivation.hasBeenActive)).toBe(true);
  const accepted = await number.inputValue();
  await number.fill("NATIVE-KEEP-DRAFT-229");
  let warning = "";
  page.once("dialog", async dialog => { warning = dialog.type(); await dialog.dismiss(); });
  await page.goBack({ waitUntil: "commit", timeout: 3_000 }).catch(error => { if (!warning) throw error; });
  expect(warning).toBe("beforeunload");
  await expect(page).toHaveURL(href);
  await expect(number).toHaveValue("NATIVE-KEEP-DRAFT-229");
  // Ordinary app departure still offers all three custom choices.
  await page.getByRole("link", { name: "← Previous", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(number).toHaveValue("NATIVE-KEEP-DRAFT-229");
  page.once("dialog", async dialog => { await dialog.accept(); });
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(firstHref);
  await page.goForward({ waitUntil: "commit" });
  await expect(page).toHaveURL(href);
  // The browser owns native Leave semantics and may restore its cached draft.
  await expect(number).toHaveValue(new RegExp(`^(${accepted}|NATIVE-KEEP-DRAFT-229)$`));
  expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await number.click();
  await number.fill("NATIVE-DISCARD-229");
  await page.getByRole("link", { name: "← Previous", exact: true }).click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(firstHref);
  // A normal Previous link creates a new entry; Back returns to the review.
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(href);
  await expect(number).toHaveValue(accepted);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await number.click();
  await number.fill("NATIVE-SAVED-229");
  await page.getByRole("link", { name: "← Previous", exact: true }).click();
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(page).toHaveURL(firstHref);
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(href);
  await expect(number).toHaveValue("NATIVE-SAVED-229");
  expect((await listExtractionVersions(client, companyId, documentId))[1].payload.documentNumber).toBe("NATIVE-SAVED-229");
  // A restored document must not keep an earlier approved-unload bypass.
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await number.click();
  await number.fill("NATIVE-NEW-DRAFT-229");
  warning = "";
  page.once("dialog", async dialog => { warning = dialog.type(); await dialog.dismiss(); });
  await page.goBack({ waitUntil: "commit", timeout: 3_000 }).catch(error => { if (!warning) throw error; });
  expect(warning).toBe("beforeunload");
  await expect(number).toHaveValue("NATIVE-NEW-DRAFT-229");
});


test("direct history and current links never invent a decision queue", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "DirectHistory");
  const ids: string[] = [];
  for (const documentNumber of ["DIRECT-APPROVE-229", "DIRECT-REJECT-229", "UNRELATED-229"]) {
    const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber } }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    ids.push(created.value.id);
  }
  for (const [index, decision] of ["approve", "reject"].entries()) {
    const href = `/companies/${companyId}/documents/${ids[index]}`;
    await page.goto(href);
    await page.getByText("Version history", { exact: true }).click();
    await page.getByRole("link", { name: /^Version 1:/ }).click();
    await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
    await expect(page.getByText(/Document \d+ of \d+/, { exact: true })).toHaveCount(0, { timeout: 3_000 });
    await page.getByRole("link", { name: "Show the current version", exact: true }).click();
    await expect(page.getByText(/Document \d+ of \d+/, { exact: true })).toHaveCount(0, { timeout: 3_000 });
    expect(new URL(page.url()).searchParams.has("view")).toBe(false);
    if (decision === "approve") await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
    else {
      await page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Reject", exact: true });
      await dialog.getByLabel("Exclusion reason", { exact: true }).fill("Direct-entry exclusion");
      await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    }
    await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents` && !url.searchParams.has("view"));
  }
  expect((await getDocument(client, companyId, ids[2]))?.status).toBe("needs_review");
  expect(await listExtractionVersions(client, companyId, ids[2])).toHaveLength(1);
});


test("a changed Reporting Period alone has Save Discard and Stay for history and browser traversal", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "ReportingDeparture");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  await period.selectOption("2026-11", { timeout: 3_000 });
  await page.getByText("Version history", { exact: true }).click();
  const history = page.getByRole("link", { name: /^Version 1:/ });
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await history.click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(period).toHaveValue("2026-11");
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBeNull();
  await history.click();
  await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("version") === "1");
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(period).toHaveValue("");
  await period.selectOption("2026-11");
  await page.getByText("Version history", { exact: true }).click();
  await history.click();
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("version") === "1");
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBe("2026-11");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(period).toHaveValue("2026-11");
  await period.selectOption("2026-12");
  await page.goBack({ waitUntil: "commit" });
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await expect(page).toHaveURL(href);
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(period).toHaveValue("2026-12");
});


test("both review drafts validate first and a refused Reporting Period keeps saved amounts and the remaining draft", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "BothDrafts");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  await period.selectOption("2026-11", { timeout: 3_000 });
  const rates = page.getByRole("group", { name: "Rate breakdown and totals", exact: true });
  await rates.getByRole("textbox", { name: "Net", exact: true }).fill("2000,00");
  await rates.getByRole("textbox", { name: "VAT", exact: true }).fill("420,00");
  await page.getByLabel("Total net", { exact: true }).fill("2000,00");
  await page.getByLabel("Total VAT", { exact: true }).fill("420,00");
  await page.getByLabel("Total incl. VAT", { exact: true }).fill("2420,00");
  const date = page.getByLabel("Tax point date", { exact: true });
  await date.fill("31.2.2026");
  await date.blur();
  await page.getByText("Version history", { exact: true }).click();
  const history = page.getByRole("link", { name: /^Version 1:/ });
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await history.click();
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(date).toHaveAttribute("aria-invalid", "true");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(1);
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBeNull();
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await date.fill("1.10.2026");
  expect((await generateVatReport(client, { companyId, period: "2026-11" })).ok).toBe(true);
  expect(await finalizeVatReport(client, { companyId, period: "2026-11", confirmed: true })).toEqual({ ok: true, value: null });
  await history.click();
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(guard.getByRole("alert")).toContainText("Not all changes were saved", { timeout: 3_000 });
  await expect(page).toHaveURL(href);
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(period).toHaveValue("2026-11");
  await expect(page.getByLabel("Total incl. VAT", { exact: true })).toHaveValue("2420.00");
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions).toHaveLength(2);
  expect(versions[1].payload).toMatchObject({ rateBreakdown: [{ rate: 21, netAmount: "2000.00", vatAmount: "420.00" }], totals: { netAmount: "2000.00", vatAmount: "420.00", grossAmount: "2420.00" } });
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBeNull();
  expect(await unlockReportingPeriod(client, { companyId, period: "2026-11", reason: "Retry the preserved period draft", confirmed: true })).toEqual({ ok: true, value: null });
  if (!await history.isVisible()) await page.getByText("Version history", { exact: true }).click();
  await history.click();
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("version") === "1");
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBe("2026-11");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toEqual(versions);
});


test("Approve resolves the unsaved Reporting Period before submitting current accounting fields", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "PeriodApprove");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  await period.selectOption("2026-11", { timeout: 3_000 });
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("CURRENT-ACCOUNTING-229");
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Unsaved Reporting Period", exact: true });
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(period).toHaveValue("2026-11");
  await expect(number).toHaveValue("CURRENT-ACCOUNTING-229");
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await guard.getByRole("button", { name: "Discard Reporting Period change and approve", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  expect((await getDocument(client, companyId, created.value.id))).toMatchObject({ status: "approved", claimedReportingPeriod: null });
  expect((await listExtractionVersions(client, companyId, created.value.id)).map(version => version.payload.documentNumber)).toEqual(["FV-2026-0001", "CURRENT-ACCOUNTING-229"]);

  const saved = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "PERIOD-SAVE-229",
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!saved.ok) throw new Error(saved.error);
  const savedHref = `/companies/${companyId}/documents/${saved.value.id}`;
  await page.goto(savedHref);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  await period.selectOption("2026-11");
  await number.fill("CURRENT-AFTER-PERIOD-SAVE-229");
  await page.getByLabel("Total incl. VAT", { exact: true }).fill("1211,00");
  const requestId = await page.locator('input[name="requestId"]').inputValue();
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${savedHref}`, async route => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) { held = true; await gate; }
    await route.continue();
  });
  try {
    await guard.getByRole("button", { name: "Save Reporting Period and approve", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await expect(number).toBeDisabled();
    await expect(period).toBeDisabled();
    await expect(page.getByLabel("Tax point date", { exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Claim selected supplies", exact: true })).toBeDisabled();
    await expect(page.getByRole("group", { name: "Document decisions", exact: true }).getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Approve version 1", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByRole("status", { name: "Warnings for these submitted values", exact: true })).toBeVisible();
  await expect(number).toHaveValue("CURRENT-AFTER-PERIOD-SAVE-229");
  await expect(page.getByLabel("Total incl. VAT", { exact: true })).toHaveValue("1211,00");
  await expect(period).toHaveValue("2026-11");
  await expect(page.locator('input[name="requestId"]')).toHaveValue(requestId);
  expect((await getDocument(client, companyId, saved.value.id))).toMatchObject({ status: "needs_review", claimedReportingPeriod: "2026-11" });
  expect(await listExtractionVersions(client, companyId, saved.value.id)).toHaveLength(1);
  await page.getByRole("button", { name: "Approve these values with warnings", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  const savedVersions = await listExtractionVersions(client, companyId, saved.value.id);
  expect(savedVersions).toHaveLength(2);
  expect(savedVersions[1].payload).toMatchObject({ documentNumber: "CURRENT-AFTER-PERIOD-SAVE-229", totals: { grossAmount: "1211.00" } });
});


test("key facts show the actual Reporting Period separately from Earliest Claim Period", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "PeriodFacts");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  expect(await updateDocumentReporting(client, { companyId, documentId: created.value.id, claimedReportingPeriod: "2026-11" })).toEqual({ ok: true, value: null });
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  const facts = page.getByRole("group", { name: "Document", exact: true });
  await expect(facts.getByText("Reporting Period: 2026-11", { exact: true })).toBeVisible({ timeout: 3_000 });
  await expect(facts.getByRole("group", { name: "Earliest Claim Period", exact: true })).toContainText("2026-10");
  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  expect(await period.evaluate(element => (element as HTMLSelectElement).form?.classList.contains("reporting-assignment-form"))).toBe(true);
  expect(await facts.getByLabel("Document number", { exact: true }).evaluate(element => (element as HTMLInputElement).form?.classList.contains("correction-form"))).toBe(true);
  // Pristine assignment follows a real refresh; edited assignments do not.
  expect(await updateDocumentReporting(client, { companyId, documentId: created.value.id, claimedReportingPeriod: "2026-12" })).toEqual({ ok: true, value: null });
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await expect(facts.getByText("Reporting Period: 2026-12", { exact: true })).toBeVisible();
  await expect(period).toHaveValue("2026-12", { timeout: 3_000 });
  await period.selectOption("2026-11");
  const number = facts.getByLabel("Document number", { exact: true });
  await number.fill("KEEP-CONCURRENT-DRAFT-229");
  const requestId = await page.locator('input[name="requestId"]').inputValue();
  expect(await updateDocumentReporting(client, { companyId, documentId: created.value.id, claimedReportingPeriod: null })).toEqual({ ok: true, value: null });
  const current = await correctDocument(client, { companyId, documentId: created.value.id, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, documentNumber: "OTHER-CURRENT-229", claimEligibility: { period: "2026-10", origin: "user", confirmed: true } },
  }, undefined, fakeVatPayerRegistry());
  expect(current.ok).toBe(true);
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await expect(facts.getByText("Reporting Period: 2026-10", { exact: true })).toBeVisible();
  await expect(period).toHaveValue("2026-11");
  await expect(number).toHaveValue("KEEP-CONCURRENT-DRAFT-229");
  await expect(page.locator('input[name="basedOnVersion"]')).toHaveValue("1");
  await expect(page.locator('input[name="requestId"]')).toHaveValue(requestId);
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  const gate = page.getByRole("dialog", { name: "Unsaved Reporting Period", exact: true });
  await expect(gate).toBeVisible({ timeout: 3_000 });
  await gate.getByRole("button", { name: "Save Reporting Period and approve", exact: true }).click();
  await expect(page.getByRole("region", { name: "Compare current data", exact: true })).toContainText("OTHER-CURRENT-229");
  await expect(number).toHaveValue("KEEP-CONCURRENT-DRAFT-229");
  await expect(page.locator('input[name="basedOnVersion"]')).toHaveValue("1");
  await expect(page.locator('input[name="requestId"]')).toHaveValue(requestId);
  expect((await getDocument(client, companyId, created.value.id))).toMatchObject({ status: "needs_review", claimedReportingPeriod: "2026-11" });
  expect(await listExtractionVersions(client, companyId, created.value.id)).toHaveLength(2);
});


test("a saved Direction change cannot remove the remaining Reporting Period draft", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "PeriodAvailability");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const period = page.getByRole("combobox", { name: /^Move input VAT claim to/ });
  await period.selectOption("2026-11", { timeout: 3_000 });
  await page.getByLabel("Direction", { exact: true }).selectOption("outgoing");
  await page.getByText("Version history", { exact: true }).click();
  const history = page.getByRole("link", { name: /^Version 1:/ });
  await history.click();
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(guard.getByRole("alert")).toContainText("Not all changes were saved", { timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(page).toHaveURL(href);
  await expect(period).toHaveValue("2026-11", { timeout: 3_000 });
  await expect(period).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save Reporting Period", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Your unsaved selection is retained" })).toBeVisible();
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions).toHaveLength(2);
  expect(versions[1].payload.direction).toBe("outgoing");
  expect((await getDocument(client, companyId, created.value.id))?.claimedReportingPeriod).toBeNull();
  await history.click();
  await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("version") === "1");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toEqual(versions);
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(page.getByLabel("Direction", { exact: true })).toHaveValue("outgoing");
  await expect(period).toHaveCount(0);
});


test("a current Period Lock refresh keeps tracking the existing readonly accounting draft", async ({ page, context, baseURL }) => {
  const { companyId, client } = await setupReviewCompany(page, context, baseURL, "ReadonlyDeparture");
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing" } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const href = `/companies/${companyId}/documents/${created.value.id}`;
  await page.goto(href);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("PRIMARY-LOCK-DRAFT-229");
  expect(await approveDocument(client, { companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  expect(await finalizeVatReport(client, { companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await expect(number).toBeDisabled();
  await expect(number).toHaveValue("PRIMARY-LOCK-DRAFT-229");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  const documents = page.getByRole("navigation", { name: "Company navigation", exact: true }).getByRole("link", { name: "Documents", exact: true });
  await documents.click();
  const guard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Save draft and continue", exact: true }).click();
  await expect(guard.getByRole("alert")).toContainText("Not all changes were saved", { timeout: 3_000 });
  await expect(page).toHaveURL(href);
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(number).toHaveValue("PRIMARY-LOCK-DRAFT-229");
  expect(await listExtractionVersions(client, companyId, created.value.id)).toEqual(versions);
  expect(await unlockReportingPeriod(client, { companyId, period: "2026-10", reason: "Restore availability without replacing the existing draft", confirmed: true })).toEqual({ ok: true, value: null });
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await expect(number).toBeEnabled();
  await expect(number).toHaveValue("PRIMARY-LOCK-DRAFT-229");
  await documents.click();
  await expect(guard).toBeVisible({ timeout: 3_000 });
  await guard.getByRole("button", { name: "Stay here", exact: true }).click();
  await documents.click();
  await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  await page.goto(`${href}?version=1`);
  await page.getByRole("link", { name: "Show the current version", exact: true }).click();
  await expect(page).toHaveURL(href);
  await documents.click();
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  await expect(guard).toHaveCount(0);
  const clean = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber: "CLEAN-LOCK-229", taxPointDate: "2026-11-01", issueDate: "2026-11-01", dueDate: "2026-11-15" } }, undefined, fakeVatPayerRegistry());
  if (!clean.ok) throw new Error(clean.error);
  await page.goto(`/companies/${companyId}/documents/${clean.value.id}`);
  await expect(page.locator(".review-actions button[form]")).toHaveCount(2);
  expect(await approveDocument(client, { companyId, documentId: clean.value.id, version: 1 })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(client, { companyId, period: "2026-11" })).ok).toBe(true);
  expect(await finalizeVatReport(client, { companyId, period: "2026-11", confirmed: true })).toEqual({ ok: true, value: null });
  await page.getByRole("button", { name: "Check payment account again", exact: true }).click();
  await expect(number).toBeDisabled();
  await documents.click();
  await expect(guard).toHaveCount(0, { timeout: 3_000 });
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
  const returned = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", documentNumber: "FIRST-RETURN-229", taxPointDate: "2026-12-01", issueDate: "2026-12-01", dueDate: "2026-12-15" } }, undefined, fakeVatPayerRegistry());
  if (!returned.ok) throw new Error(returned.error);
  expect(await approveDocument(client, { companyId, documentId: returned.value.id, version: 1 })).toEqual({ ok: true, value: null });
  await page.goto(`/companies/${companyId}/documents/${returned.value.id}`);
  const field = page.locator('[data-source-field="documentNumber"]');
  await field.focus();
  await expect(field).toHaveClass(/is-selected/);
  const currentForm = await page.locator("form.correction-form").elementHandle();
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await expect(number).toBeEnabled();
  expect(await currentForm!.evaluate(element => element.isConnected)).toBe(true);
  await documents.click();
  await expect(guard).toHaveCount(0, { timeout: 3_000 });
  await expect(page).toHaveURL(url => url.pathname === `/companies/${companyId}/documents`);
});
