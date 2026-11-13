import { afterEach, expect, it } from "vitest";
import { promotedSuperAdministrator, revokeSuperAdministratorFixture } from "./support/platform";
import { provisionedUser } from "./support/clients";
import { getOperationalAlertPreference, setOperationalAlertPreference, listOperationalAlertDeliveries } from "@/application/operational-email-alerts";

import { companyWithWaitingDocuments, removeAiConfigurationFixture } from "./support/fixtures";
import { listCompanyDocuments, startManualDocumentReview } from "@/application/documents";
import { systemClient } from "./support/worker";
import { runOperationalAlertTick, type OperationalAlertMailer, type OperationalAlertMessage } from "@/application/operational-alert-worker";

import { clearOperationalAlertAllowanceFixture, documentAlertRequest } from "./support/operational-alerts";

const companies: Awaited<ReturnType<typeof companyWithWaitingDocuments>>[] = [];
const subscribers: Awaited<ReturnType<typeof promotedSuperAdministrator>>[] = [];
afterEach(async () => {
  for (const company of companies.splice(0)) {
    for (const document of await listCompanyDocuments(company.client, company.companyId)) {
      await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    }
    await clearOperationalAlertAllowanceFixture(company.companyId);
    expect((await listCompanyDocuments(company.client, company.companyId)).every(document => document.status === "needs_review")).toBe(true);
  }
  for (const subscriber of subscribers.splice(0)) await systemClient().auth.admin.deleteUser(subscriber.userId);
});

async function scenario(count = 2, locale: "cs" | "en" = "en") {
  const admin = await promotedSuperAdministrator("Operational subscriber"); subscribers.push(admin);
  await setOperationalAlertPreference(admin.client, { enabled: true, locale });
  const company = await companyWithWaitingDocuments(count); companies.push(company);
  await removeAiConfigurationFixture(company.client, company.companyId);
  const messages: OperationalAlertMessage[] = [];
  const mailer: OperationalAlertMailer = { async send(message) { messages.push(message); return "accepted"; } };
  const scopes = new Set([company.companyId]);
  const start = Date.now() + 1000;
  const deliveries = async () => {
    const result = await listOperationalAlertDeliveries(admin.client);
    if (!result.ok) throw new Error(result.error);
    return result.value.filter(delivery => [...scopes].some(scope => delivery.rootKey.split(":").includes(scope)));
  };
  const tick = async (seconds: number, transport = mailer) => {
    await runOperationalAlertTick(systemClient(), { mailer: transport,
      now: new Date(start + seconds * 1000).toISOString(), appOrigin: "https://ivat.example.test" });
    // Other test files may leave legitimate active platform incidents. Observe
    // this scenario's public receipt IDs rather than assuming an empty platform.
    const result = await listOperationalAlertDeliveries(admin.client);
    if (result.ok) {
      const relevant = result.value.filter(delivery => [...scopes].some(scope => delivery.rootKey.split(":").includes(scope)));
      messages.splice(0, messages.length, ...messages.filter(message => relevant.some(delivery => message.messageId.includes(delivery.id))));
    }
  };
  return { admin, company, messages, mailer, tick, deliveries, start, scopes };
}

it("keeps alerts off until a SuperAdmin explicitly opts in on their verified account", async () => {
  const admin = await promotedSuperAdministrator("Alert preferences");
  expect(await getOperationalAlertPreference(admin.client)).toEqual({ ok: true, value: { enabled: false, locale: "cs" } });
  expect(await setOperationalAlertPreference(admin.client, { enabled: true, locale: "en" })).toEqual({ ok: true, value: null });
  expect(await getOperationalAlertPreference(admin.client)).toEqual({ ok: true, value: { enabled: true, locale: "en" } });
  expect(await setOperationalAlertPreference(admin.client, { enabled: false, locale: "cs" })).toEqual({ ok: true, value: null });
  expect(await getOperationalAlertPreference(admin.client)).toEqual({ ok: true, value: { enabled: false, locale: "cs" } });
  const ordinary = await provisionedUser("No operational subscription");
  expect(await setOperationalAlertPreference(ordinary.client, { enabled: true, locale: "cs" })).toEqual({ ok: false, error: "forbidden" });
  expect(await getOperationalAlertPreference(ordinary.client)).toEqual({ ok: false, error: "forbidden" });
});

it("sends one grouped alert at five continuous minutes and deduplicates concurrent ticks", async () => {
  const { admin, messages, tick } = await scenario();
  await tick(0);
  await tick(299);
  expect(messages.filter(message => message.to === admin.email)).toHaveLength(0);
  await Promise.all([tick(300), tick(300)]);
  const delivered = messages.filter(message => message.to === admin.email);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].subject).toBe("iVAT: critical operational blockage");
  expect(delivered[0].text).toContain("Critical work has been blocked for at least five minutes");
  expect(delivered[0].text).toContain("Sign in to review and resolve the blockage");
  expect(delivered[0].html).toContain("Documents: 2");
  expect(delivered[0].text).toContain("Documents: 2");
  expect(delivered[0].text).toContain("Companies: 1");
  expect(delivered[0].text).toContain("https://ivat.example.test/platform/ai-settings");
  await tick(360);
  expect(messages.filter(message => message.to === admin.email)).toHaveLength(1);
  await setOperationalAlertPreference(admin.client, { enabled: false, locale: "en" });
});

it("preserves the grace period when the same root still blocks fewer Documents", async () => {
  const { company, messages, tick, deliveries } = await scenario();
  await tick(0);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  await tick(299);
  expect(messages).toHaveLength(0);
  await tick(300);
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain("Documents: 1");
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "accepted", impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } })]);
});

it.each(["refused", "failed", "unknown"] as const)("keeps %s distinct from acceptance and never blindly resends", async outcome => {
  const { messages, tick, deliveries } = await scenario(1);
  await tick(0);
  const transport: OperationalAlertMailer = { async send(message) { messages.push(message); return outcome; } };
  await tick(300, transport);
  expect((await deliveries()).map(delivery => delivery.state)).toEqual([outcome]);
  await tick(3600, transport);
  expect(messages).toHaveLength(1);
});

it("marks a transport exception unknown without a false sent result or a recursive alert", async () => {
  const { company, tick, deliveries } = await scenario(1);
  await tick(0);
  let sends = 0;
  await tick(300, { async send(message) { if (message.text.includes(company.companyId)) sends++; throw new Error("private SMTP failure payload"); } });
  expect((await deliveries()).map(delivery => delivery.state)).toEqual(["unknown"]);
  await tick(10000);
  expect(sends).toBe(1);
  expect(JSON.stringify(await deliveries())).not.toContain("private SMTP");
});

it.each(["opt_out", "role_removed", "deactivated", "unverified", "email_change"])("rechecks %s before dispatching a durable pending delivery", async reason => {
  const { admin, start, tick, messages } = await scenario(1);
  await tick(0);
  const system = systemClient();
  const planned = await system.rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() });
  expect(planned.error).toBeNull();
  expect((planned.data as string[]).length).toBeGreaterThan(0);
  if (reason === "opt_out") await setOperationalAlertPreference(admin.client, { enabled: false, locale: "en" });
  if (reason === "role_removed") await revokeSuperAdministratorFixture(admin.userId);
  if (reason === "deactivated") await system.auth.admin.updateUserById(admin.userId, { ban_duration: "24h" });
  if (reason === "unverified" || reason === "email_change") {
    const { alertAccountFixture } = await import("./support/operational-alerts");
    await alertAccountFixture(admin.userId, reason);
  }
  await tick(300);
  expect(messages).toHaveLength(0);
});

it("uses the current verified address at claim time, never the queued address", async () => {
  const { admin, start, tick, messages } = await scenario(1);
  await tick(0);
  await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() });
  const updated = await systemClient().auth.admin.updateUserById(admin.userId, { email: `current-${admin.userId}@example.test`, email_confirm: true });
  expect(updated.error).toBeNull();
  await tick(300);
  expect(messages.map(message => message.to)).toEqual([`current-${admin.userId}@example.test`]);
});

it("never reclaims an interrupted sending receipt after worker restart", async () => {
  const { admin, start, tick, messages, deliveries } = await scenario(1);
  await tick(0);
  const system = systemClient();
  const planned = await system.rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() });
  const pending = await deliveries();
  expect(pending).toHaveLength(1);
  expect(planned.data).toContain(pending[0].id);
  const claim = await system.rpc("claim_operational_alert", { target_delivery_id: pending[0].id, observed_at: new Date(start + 300000).toISOString() });
  expect(claim.error).toBeNull(); expect(claim.data).not.toBeNull();
  await tick(301);
  expect((await deliveries())[0].state).toBe("sending");
  await tick(420);
  expect((await deliveries())[0].state).toBe("unknown");
  expect(messages).toHaveLength(0);
  expect((await listOperationalAlertDeliveries(admin.client)).ok).toBe(true);
});

it.each([
  ["accepted", "cs"], ["refused", "cs"], ["unknown", "cs"],
  ["accepted", "en"], ["refused", "en"], ["unknown", "en"],
] as const)("records the real controlled SMTP %s outcome in %s through reconciliation and outbox", async (outcome, locale) => {
  const { localSmtpCapture } = await import("./support/smtp-capture");
  const { smtpOperationalAlertMailer } = await import("@/mail/smtp-operational-alert-mailer");
  const capture = await localSmtpCapture(outcome);
  try {
    const { tick, deliveries } = await scenario(1, locale);
    const smtp = smtpOperationalAlertMailer({ host: "127.0.0.1", port: capture.port, sender: "noreply@example.test", localCapture: true });
    await tick(0, smtp); await tick(300, smtp);
    expect((await deliveries()).map(delivery => delivery.state)).toEqual([outcome]);
    const ownMessages = async () => {
      const receipts = await deliveries();
      return capture.messages.filter(message => receipts.some(receipt => message.includes(receipt.id)));
    };
    expect(await ownMessages()).toHaveLength(outcome === "refused" ? 0 : 1);
    await tick(3600, smtp);
    expect(await ownMessages()).toHaveLength(outcome === "refused" ? 0 : 1);
  } finally { await capture.close(); }
});

it("refuses worker transitions to users and preserves the human MFA requirement", async () => {
  const admin = await promotedSuperAdministrator("Worker boundary");
  const ordinary = await provisionedUser("Worker refusal");
  const { anonymousClient } = await import("./support/clients");
  const weak = anonymousClient();
  expect((await weak.auth.signInWithPassword({ email: admin.email, password: "correct-horse-battery" })).error).toBeNull();
  expect(await getOperationalAlertPreference(weak)).toEqual({ ok: false, error: "forbidden" });
  expect(await setOperationalAlertPreference(weak, { enabled: true, locale: "cs" })).toEqual({ ok: false, error: "forbidden" });
  for (const client of [ordinary.client, admin.client, weak]) {
    expect((await client.rpc("reconcile_operational_alerts")).error?.code).toBe("42501");
    expect((await client.rpc("claim_operational_alert", { target_delivery_id: crypto.randomUUID() })).error?.code).toBe("42501");
    expect((await client.rpc("finish_operational_alert", { target_delivery_id: crypto.randomUUID(), target_claim_token: crypto.randomUUID(), transport_outcome: "accepted" })).error?.code).toBe("42501");
  }
  for (const name of ["list_platform_ai_processing_allowances", "list_platform_ai_processing_issues", "list_platform_operational_context"] as const) {
    expect((await systemClient().rpc(name)).error?.code).toBe("42501");
    expect((await weak.rpc(name)).error?.code).toBe("42501");
  }
});

it("groups a shared configuration across Companies and keeps the same episode as impact changes", async () => {
  const { createAiConfiguration, assignCompanyAiConfiguration } = await import("@/application/ai-configurations");
  const { admin, company, tick, messages, deliveries, scopes } = await scenario(2);
  const second = await companyWithWaitingDocuments(3); companies.push(second);
  const configuration = await createAiConfiguration(admin.client, { label: `PRIVATE <configuration> ${crypto.randomUUID()}`,
    provider: "anthropic", splitModel: "test-split", extractModel: "test-extract", credential: "private-provider-credential" });
  if (!configuration.ok) throw new Error(configuration.error);
  scopes.add(configuration.value.id);
  for (const owner of [company, second]) {
    expect(await assignCompanyAiConfiguration(admin.client, { companyId: owner.companyId, configurationId: configuration.value.id })).toEqual({ ok: true, value: null });
    for (const document of await listCompanyDocuments(owner.client, owner.companyId)) {
      expect((await systemClient().rpc("record_ai_processing_issue", { target_kind: "document", target_id: document.id, target_extraction_request_id: await documentAlertRequest(document.id),
        target_classification: "invalid_credentials", target_state: "waiting_for_platform", target_configuration_id: configuration.value.id })).error).toBeNull();
    }
  }
  await tick(0);
  await tick(299); expect(messages).toHaveLength(0);
  const [reviewed] = await listCompanyDocuments(company.client, company.companyId);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: reviewed.id });
  await tick(300);
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain("Documents: 4"); expect(messages[0].text).toContain("Companies: 2");
  expect(JSON.stringify(messages)).not.toContain("PRIVATE"); expect(JSON.stringify(messages)).not.toContain("private-provider-credential");
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "accepted", impact: { documents: 4, companies: 2, exportJobs: 0, sourceFiles: 0 } })]);
});

it("keeps transient provider warnings and exhausted allowance without waiting work in-app", async () => {
  const { setCompanyAiProcessingAllowance } = await import("@/application/ai-processing-allowance");
  const { admin, company, tick, messages } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect((await systemClient().rpc("record_ai_processing_issue", { target_kind: "document", target_id: document.id, target_extraction_request_id: await documentAlertRequest(document.id),
    target_classification: "provider_unavailable", target_state: "waiting_for_platform" })).error).toBeNull();
  await tick(0); await tick(300); expect(messages).toHaveLength(0);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  expect(await setCompanyAiProcessingAllowance(admin.client, { async send() {} }, { companyId: company.companyId, allowance: 0 })).toEqual({ ok: true, value: null });
  await tick(600); await tick(900); expect(messages).toHaveLength(0);
});

it("sends for actual allowance waits while an 80-percent Company remains warning-only", async () => {
  const { setCompanyAiProcessingAllowance } = await import("@/application/ai-processing-allowance");
  const { companyWithManyReportDocuments, assignAiConfigurationFixture } = await import("./support/fixtures");
  const { companyAlertConfigurationFixture } = await import("./support/operational-alerts");
  const { testWorker } = await import("./support/worker");
  const { admin, company, tick, messages, scopes } = await scenario(1);
  const high = await companyWithManyReportDocuments(8); companies.push(high);
  expect(await setCompanyAiProcessingAllowance(admin.client, { async send() {} }, { companyId: high.companyId, allowance: 10 })).toEqual({ ok: true, value: null });
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  const worker = testWorker();
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  scopes.add(await companyAlertConfigurationFixture(company.companyId));
  expect(await setCompanyAiProcessingAllowance(admin.client, worker.jobs, { companyId: company.companyId, allowance: 0 })).toEqual({ ok: true, value: null });
  // The allowance mutation requeues work; the genuine handler discovers that
  // zero allowance still requires a wait before an extraction can begin.
  expect(await worker.runJobs()).toEqual([]);
  expect((await listCompanyDocuments(company.client, company.companyId)).find(waiting => waiting.id === document.id)?.status).toBe("waiting_for_allowance");
  await tick(0); await tick(299); expect(messages).toHaveLength(0);
  await tick(300); expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain("Documents: 1");
  expect(messages[0].text).toMatch(/allowance/i);
});

it("starts a fresh grace period after an intervening complete resolution even between ticks", async () => {
  const { reprocessDocument } = await import("@/application/documents");
  const { company, tick, messages } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await tick(0);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
  expect(await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  await tick(299); await tick(300);
  expect(messages).toHaveLength(0);
  await tick(599); expect(messages).toHaveLength(1);
});

it.each([
  "configuration_missing", "configuration_unusable", "invalid_credentials",
  "provider_credits_exhausted", "provider_unavailable", "provider_response_invalid", "processing_failed",
] as const)("keeps %s issue eligibility and synchronous manual resolution consistent", async classification => {
  const { company, tick, messages, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  const recorded = await systemClient().rpc("record_ai_processing_issue", {
    target_kind: "document", target_id: document.id,
    target_extraction_request_id: await documentAlertRequest(document.id),
    target_classification: classification, target_state: "terminal",
  });
  expect(recorded.error).toBeNull();
  await tick(0);
  await tick(300);
  expect(messages).toHaveLength(1);
  expect(await deliveries()).toEqual([expect.objectContaining({ kind: classification, state: "accepted", resolvedAt: null })]);
  expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  // Read immediately, without another reconciliation tick.
  expect(await deliveries()).toEqual([expect.objectContaining({ kind: classification, resolvedAt: expect.any(String) })]);
});

it("cancels pending delivery synchronously and starts fresh grace after manual recovery", async () => {
  const { reprocessDocument } = await import("@/application/documents");
  const { company, start, tick, messages, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await tick(0);
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "pending", resolvedAt: null })]);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) })]);
  await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: document.id });
  await tick(301); await tick(600); expect(messages).toHaveLength(0);
  await tick(601); expect(messages).toHaveLength(1);
});

it.each(["independent", "overlapping"] as const)("ends a shared incident at concurrent remediation commits (%s) and requires full fresh grace for recurrence", async interleaving => {
  const { createAiConfiguration, assignCompanyAiConfiguration } = await import("@/application/ai-configurations");
  const { reprocessDocument } = await import("@/application/documents");
  const { manualReviewTransactionFixture } = await import("./support/operational-alerts");
  const { admin, company, start, tick, messages, deliveries, scopes } = await scenario(1);
  const second = await companyWithWaitingDocuments(1); companies.push(second);
  const configuration = await createAiConfiguration(admin.client, { label: `Concurrent shared ${crypto.randomUUID()}`, provider: "anthropic", splitModel: "test", extractModel: "test", credential: "synthetic-test-credential" });
  if (!configuration.ok) throw new Error(configuration.error);
  scopes.add(configuration.value.id);
  const documents: Awaited<ReturnType<typeof listCompanyDocuments>> = [];
  for (const owner of [company, second]) {
    await assignCompanyAiConfiguration(admin.client, { companyId: owner.companyId, configurationId: configuration.value.id });
    const [document] = await listCompanyDocuments(owner.client, owner.companyId);
    documents.push(document);
    expect((await systemClient().rpc("record_ai_processing_issue", {
      target_kind: "document", target_id: document.id,
      target_extraction_request_id: await documentAlertRequest(document.id),
      target_configuration_id: configuration.value.id,
      target_classification: "invalid_credentials", target_state: "waiting_for_platform",
    })).error).toBeNull();
  }
  await tick(0);
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
  const [oldDelivery] = await deliveries();
  expect(oldDelivery).toEqual(expect.objectContaining({ state: "pending", resolvedAt: null, impact: { companies: 2, documents: 2, sourceFiles: 0, exportJobs: 0 } }));
  if (interleaving === "overlapping") {
    const { generateInvitationLink, acceptInvitation } = await import("@/application/memberships");
    const invitation = await generateInvitationLink(second.client, { organizationId: second.organizationId, companyId: second.companyId, email: company.email, role: "user", acceptUrl: "https://ivat.example.test/invitations/accept" });
    if (!invitation.ok) throw new Error(invitation.error);
    expect(await acceptInvitation(company.client, invitation.value.token)).toEqual({ ok: true, value: null });
  }
  const transactions = await Promise.all([manualReviewTransactionFixture(company.client), manualReviewTransactionFixture(second.client)]);
  try {
    // Both commands finish their mutations while the other connection's work is
    // still uncommitted. Neither can see a globally quiet root until commit.
    await Promise.all(transactions.map((transaction, index) => transaction.review(documents[index].id)));
    // Reconciliation also completes while both Companies are locked. It sees
    // their still-committed blockage; it cannot deadlock on Company locks.
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
    if (interleaving === "overlapping") {
      // The first transaction needs the second Company later in its command.
      // The second can commit without waiting for an alert lock held by the
      // first, then the first finishes its remaining mutation and commits.
      const remaining = transactions[0].review(documents[1].id);
      await transactions[1].commit();
      await remaining;
      await transactions[0].commit();
    } else {
      await Promise.all(transactions.map(transaction => transaction.commit()));
    }
  } finally { await Promise.all(transactions.map(transaction => transaction.close())); }
  for (const [index, owner] of [company, second].entries()) {
    expect((await listCompanyDocuments(owner.client, owner.companyId)).find(document => document.id === documents[index].id)?.status).toBe("needs_review");
  }
  expect(await deliveries()).toEqual([expect.objectContaining({ id: oldDelivery.id, state: "cancelled", resolvedAt: expect.any(String) })]);
  await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: documents[0].id });
  expect((await systemClient().rpc("record_ai_processing_issue", {
    target_kind: "document", target_id: documents[0].id,
    target_extraction_request_id: await documentAlertRequest(documents[0].id),
    target_configuration_id: configuration.value.id,
    target_classification: "invalid_credentials", target_state: "waiting_for_platform",
  })).error).toBeNull();
  await tick(301); await tick(600); expect(messages).toHaveLength(0);
  await tick(601); expect(messages).toHaveLength(1);
  expect(await deliveries()).toEqual([
    expect.objectContaining({ id: oldDelivery.id, state: "cancelled" }),
    expect.objectContaining({ id: expect.not.stringMatching(oldDelivery.id), state: "accepted", impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } }),
  ]);
});

it("closes an incident first observed while remediation is uncommitted before the command commits", async () => {
  const { manualReviewTransactionFixture } = await import("./support/operational-alerts");
  const { company, start, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  const transaction = await manualReviewTransactionFixture(company.client);
  try {
    await transaction.review(document.id);
    // The worker can still observe the old committed Document even though the
    // public command has already completed all its row mutations.
    await tick(0);
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
    expect(await deliveries()).toEqual([expect.objectContaining({ state: "pending", resolvedAt: null })]);
    await transaction.commit();
  } finally { await transaction.close(); }
  expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) })]);
});

it("cancels a pending allowance alert immediately when the Company receives sufficient allowance", async () => {
  const { setCompanyAiProcessingAllowance, getCompanyAiProcessingAllowance } = await import("@/application/ai-processing-allowance");
  const { assignAiConfigurationFixture } = await import("./support/fixtures");
  const { companyAlertConfigurationFixture } = await import("./support/operational-alerts");
  const { testWorker } = await import("./support/worker");
  const { admin, company, start, tick, deliveries, scopes } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  const worker = testWorker();
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  scopes.add(await companyAlertConfigurationFixture(company.companyId));
  expect(await setCompanyAiProcessingAllowance(admin.client, worker.jobs, { companyId: company.companyId, allowance: 0 })).toEqual({ ok: true, value: null });
  expect(await worker.runJobs()).toEqual([]);
  expect((await listCompanyDocuments(company.client, company.companyId)).find(waiting => waiting.id === document.id)?.status).toBe("waiting_for_allowance");
  await tick(0);
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
  expect(await deliveries()).toEqual([expect.objectContaining({ kind: "allowance_exhausted", state: "pending", resolvedAt: null })]);
  expect(await setCompanyAiProcessingAllowance(admin.client, { async send() {} }, { companyId: company.companyId, allowance: null })).toEqual({ ok: true, value: null });
  expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ used: 0, allowance: null }) }));
  expect(await deliveries()).toEqual([expect.objectContaining({ kind: "allowance_exhausted", state: "cancelled", resolvedAt: expect.any(String) })]);
});

it("splits 1001 new Documents in a Company with an active incident without restarting that incident's grace", async () => {
  const { assignAiConfigurationFixture } = await import("./support/fixtures");
  const { companyAlertConfigurationFixture } = await import("./support/operational-alerts");
  const { uploadSourceFile } = await import("@/application/source-files");
  const { workbookFile } = await import("./support/files");
  const { testWorker } = await import("./support/worker");
  const admin = await promotedSuperAdministrator("Related bulk subscriber"); subscribers.push(admin);
  await setOperationalAlertPreference(admin.client, { enabled: true, locale: "en" });
  // This completed bulk fixture is retained, like the other large Split cases;
  // only the deliberately blocked Document needs manual remediation below.
  const company = await companyWithWaitingDocuments(1);
  const [blocked] = await listCompanyDocuments(company.client, company.companyId);
  const worker = testWorker();
  await assignAiConfigurationFixture(company.client, { async send() {} }, { companyId: company.companyId, provider: worker.ai });
  const configurationId = await companyAlertConfigurationFixture(company.companyId);
  expect((await systemClient().rpc("record_ai_processing_issue", {
    target_kind: "document", target_id: blocked.id,
    target_extraction_request_id: await documentAlertRequest(blocked.id),
    target_configuration_id: configurationId,
    target_classification: "invalid_credentials", target_state: "waiting_for_platform",
  })).error).toBeNull();
  const messages: OperationalAlertMessage[] = [];
  const start = Date.now() + 1000;
  const tick = async (seconds: number) => runOperationalAlertTick(systemClient(), {
    mailer: { async send(message) { messages.push(message); return "accepted"; } },
    now: new Date(start + seconds * 1000).toISOString(), appOrigin: "https://ivat.example.test",
  });
  const ownDeliveries = async () => {
    const result = await listOperationalAlertDeliveries(admin.client);
    if (!result.ok) throw new Error(result.error);
    return result.value.filter(delivery => delivery.rootKey === `invalid_credentials:${configurationId}`);
  };
  try {
    await tick(0);
    worker.ai.split = async () => ({ model: "fake-bulk-split", documents: Array.from({ length: 1001 }, (_, index) => ({ sheetName: "Invoices", firstRow: index + 2, lastRow: index + 2 })) });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "related-bulk.xlsx", bytes: workbookFile("xlsx", [["Invoice"], ...Array.from({ length: 1001 }, (_, index) => [`INV-${index}`])]) });
    if (!source.ok) throw new Error(source.error);
    await worker.runNextJob();
    const documents = await listCompanyDocuments(company.client, company.companyId);
    expect(documents.filter(document => document.sourceFileId === source.value.id)).toHaveLength(1001);
    expect(documents.find(document => document.id === blocked.id)?.status).toBe("waiting_for_platform");
    await tick(299); expect(await ownDeliveries()).toEqual([]);
    await tick(300);
    const own = await ownDeliveries();
    expect(own).toEqual([expect.objectContaining({ state: "accepted", resolvedAt: null, impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } })]);
    expect(messages.filter(message => own.some(delivery => message.messageId.includes(delivery.id)))).toHaveLength(1);
  } finally {
    expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: blocked.id })).toEqual({ ok: true, value: null });
  }
});

it("observes both configuration scopes on reassignment while another Company preserves the shared root", async () => {
  const { createAiConfiguration, assignCompanyAiConfiguration } = await import("@/application/ai-configurations");
  const { assignedCompanyWithDisabledAiFixture } = await import("./support/operational-alerts");
  const { admin, company, tick, messages, deliveries, scopes } = await scenario(1);
  const second = await companyWithWaitingDocuments(1); companies.push(second);
  await removeAiConfigurationFixture(second.client, second.companyId);
  const first = await createAiConfiguration(admin.client, { label: `Shared ${crypto.randomUUID()}`, provider: "anthropic", splitModel: "test", extractModel: "test", credential: "synthetic-test-credential" });
  const replacement = await createAiConfiguration(admin.client, { label: `Replacement ${crypto.randomUUID()}`, provider: "anthropic", splitModel: "test", extractModel: "test", credential: "synthetic-test-credential" });
  if (!first.ok || !replacement.ok) throw new Error("Configuration fixture failed");
  scopes.add(first.value.id); scopes.add(replacement.value.id);
  for (const owner of [company, second]) {
    expect(await assignCompanyAiConfiguration(admin.client, { companyId: owner.companyId, configurationId: first.value.id })).toEqual({ ok: true, value: null });
    await assignedCompanyWithDisabledAiFixture(owner.companyId);
  }
  await tick(0);
  expect(await assignCompanyAiConfiguration(admin.client, { companyId: company.companyId, configurationId: replacement.value.id })).toEqual({ ok: true, value: null });
  await assignedCompanyWithDisabledAiFixture(company.companyId);
  await tick(299);
  await tick(300);
  expect(messages).toHaveLength(1);
  expect(await deliveries()).toEqual([expect.objectContaining({ rootKey: `waiting_documents:${first.value.id}`, impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } })]);
  const [remaining] = await listCompanyDocuments(second.client, second.companyId);
  await startManualDocumentReview(second.client, { companyId: second.companyId, documentId: remaining.id });
  expect(await deliveries()).toEqual([expect.objectContaining({ rootKey: `waiting_documents:${first.value.id}`, resolvedAt: expect.any(String) })]);
  await tick(598); expect(messages).toHaveLength(1);
  await tick(599); expect(messages).toHaveLength(2);
});

it("cancels a Source File incident immediately when manual Source recovery resolves its work", async () => {
  const { uploadSourceFile, startManualSourceReview, getSourceFile } = await import("@/application/source-files");
  const { fixtureFile } = await import("./support/files");
  const { sourceSplitRequestFixture } = await import("./support/source-request");
  const { company, start, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  const source = await uploadSourceFile(company.client, { async send() {} }, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!source.ok) throw new Error(source.error);
  expect((await systemClient().rpc("record_ai_processing_issue", {
    target_kind: "source_file", target_id: source.value.id,
    target_split_request_id: await sourceSplitRequestFixture(systemClient(), source.value.id),
    target_classification: "configuration_missing", target_state: "waiting_for_platform",
  })).error).toBeNull();
  await tick(0);
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
  expect(await deliveries()).toEqual([expect.objectContaining({ kind: "configuration_missing", state: "pending", impact: { companies: 1, documents: 0, sourceFiles: 1, exportJobs: 0 } })]);
  expect(await startManualSourceReview(company.client, { companyId: company.companyId, sourceFileId: source.value.id })).toEqual({ ok: true, value: null });
  expect(await getSourceFile(company.client, company.companyId, source.value.id)).toEqual(expect.objectContaining({ status: "needs_review" }));
  expect(await deliveries()).toEqual([expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) })]);
});

it("still invalidates a failed export synchronously when only its Company data revision changes", async () => {
  const { createBoss, createProcessingQueues } = await import("@/lib/jobs");
  const { exportCompanyData } = await import("@/application/company-deletion");
  const { uploadSourceFile } = await import("@/application/source-files");
  const { fixtureFile } = await import("./support/files");
  const { company, start, tick, deliveries } = await scenario(1);
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  try {
    const exported = await exportCompanyData(company.client, { async send(job) { await boss.send(job.name, job.data, { retryLimit: 0 }); } }, { companyId: company.companyId });
    if (!exported.ok) throw new Error(exported.error);
    const jobs = await boss.fetch("complete-company-export", { includeMetadata: true, batchSize: 100 });
    const ownJob = jobs.find(job => (job.data as { exportId: string }).exportId === exported.value.exportId);
    if (!ownJob) throw new Error("Export fixture not claimed");
    await boss.fail("complete-company-export", ownJob.id, { message: "synthetic export failure" });
    await tick(0);
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 300000).toISOString() })).error).toBeNull();
    expect((await deliveries()).filter(delivery => delivery.kind === "failed_company_export")).toEqual([expect.objectContaining({ state: "pending", resolvedAt: null })]);
    const uploaded = await uploadSourceFile(company.client, { async send() {} }, { companyId: company.companyId, fileName: "later.png", bytes: fixtureFile("receipt.png") });
    expect(uploaded.ok).toBe(true);
    expect((await deliveries()).filter(delivery => delivery.kind === "failed_company_export")).toEqual([expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) })]);
    expect((await deliveries()).filter(delivery => delivery.kind === "waiting_documents")).toEqual([expect.objectContaining({ state: "pending", resolvedAt: null })]);
  } finally { await boss.stop(); }
});

it("includes durable terminal processing failure and failed export with truthful units", async () => {
  const { createBoss, createProcessingQueues } = await import("@/lib/jobs");
  const { exportCompanyData, getCompanyDataExportStatus } = await import("@/application/company-deletion");
  const { closeFailedExportAttempt, takeOverFailedProcessingJob, listFailedProcessingJobs } = await import("@/application/processing-administration");
  const { legacyUnclassifiedFailedDocumentFixture } = await import("./support/operational-alerts");
  const { admin, company, tick, messages, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  try {
    // Retained unclassified failure, not proof of today's classified AI handler:
    // the real pg-boss attempt and public remediation below exercise that legacy path.
    await legacyUnclassifiedFailedDocumentFixture(document.id);
    const processingId = await boss.send("extract-document", { documentId: document.id }, { retryLimit: 0 });
    if (!processingId) throw new Error("processing enqueue failed");
    const processingJobs = await boss.fetch("extract-document", { includeMetadata: true, batchSize: 100 });
    const processingJob = processingJobs.find(job => job.id === processingId);
    if (!processingJob) throw new Error("Processing claim failed");
    await boss.fail("extract-document", processingJob.id, { message: "PRIVATE_PROVIDER_RESPONSE" });
    const failures = await listFailedProcessingJobs(admin.client);
    if (!failures.ok) throw new Error(failures.error);
    expect(failures.value).toContainEqual(expect.objectContaining({ id: processingId, name: "extract-document", targetId: document.id, retryCount: processingJob.retryCount }));
    const exported = await exportCompanyData(company.client, { async send(job) { await boss.send(job.name, job.data, { retryLimit: 0 }); } }, { companyId: company.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect((await systemClient().rpc("fail_company_data_export", { target_export_id: exported.value.exportId })).error).toBeNull();
    const exportJobs = await boss.fetch("complete-company-export", { includeMetadata: true, batchSize: 100 });
    const exportJob = exportJobs.find(job => (job.data as { exportId: string }).exportId === exported.value.exportId);
    if (!exportJob) throw new Error("export claim failed");
    await boss.fail("complete-company-export", exportJobs.map(job => job.id), { message: "PRIVATE_EXPORT_ERROR" });
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("failed");
    expect(await getCompanyDataExportStatus(company.client, { companyId: company.companyId, exportId: exported.value.exportId })).toEqual({ ok: true, value: "failed" });
    await tick(0); await tick(299); expect(messages).toHaveLength(0);
    await tick(300); expect(messages).toHaveLength(2);
    const delivered = await deliveries();
    expect(delivered).toContainEqual(expect.objectContaining({ kind: "terminal_processing_job", state: "accepted", impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } }));
    expect(delivered).toContainEqual(expect.objectContaining({ kind: "failed_company_export", state: "accepted", impact: { companies: 1, documents: 0, sourceFiles: 0, exportJobs: 1 } }));
    expect(JSON.stringify(messages)).not.toContain("PRIVATE_");
    // Close the exact export attempt before processing remediation changes the
    // Company's data revision and correctly makes that archive attempt obsolete.
    expect(await closeFailedExportAttempt(admin.client, exportJob.id, exportJob.retryCount)).toEqual({ ok: true, value: null });
    expect(await takeOverFailedProcessingJob(admin.client, processingId)).toEqual({ ok: true, value: null });
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
    await tick(600); expect(messages).toHaveLength(2);
    expect((await deliveries()).every(delivery => delivery.resolvedAt !== null)).toBe(true);
  } finally { await boss.stop(); }
});

it("refuses opt-in without a verified current address and localizes both safe message bodies", async () => {
  const admin = await promotedSuperAdministrator("Unverified subscription"); subscribers.push(admin);
  const { alertAccountFixture } = await import("./support/operational-alerts");
  await alertAccountFixture(admin.userId, "unverified");
  expect(await setOperationalAlertPreference(admin.client, { enabled: true, locale: "cs" })).toEqual({ ok: false, error: "verified_email_required" });
  expect(await getOperationalAlertPreference(admin.client)).toEqual({ ok: true, value: { enabled: false, locale: "cs" } });
  const { tick, messages } = await scenario(1, "cs");
  await tick(0); await tick(300);
  expect(messages).toHaveLength(1);
  expect(messages[0].subject).toBe("iVAT: kritická provozní blokace");
  expect(messages[0].text).toContain("Kritická práce je blokována alespoň pět minut");
  expect(messages[0].text).toContain("Přihlaste se pro kontrolu a nápravu blokace");
  expect(messages[0].text).toContain("Doklady: 1");
  expect(messages[0].html).toContain("Doklady: 1");
  expect(messages[0].html).toContain('href="https://ivat.example.test/platform/ai-settings#company-');
});
