import { afterEach, expect, it } from "vitest";
import { promotedSuperAdministrator, revokeSuperAdministratorFixture } from "./support/platform";
import { provisionedUser } from "./support/clients";
import { deactivateAccountFixture, deleteAccountFixture, setVerifiedAccountEmailFixture } from "./support/accounts";
import { getOperationalAlertPreference, setOperationalAlertPreference, listOperationalAlertDeliveries } from "@/application/operational-email-alerts";

import { companyWithWaitingDocuments, removeAiConfigurationFixture } from "./support/fixtures";
import { listCompanyDocuments, startManualDocumentReview } from "@/application/documents";
import { systemClient } from "./support/worker";
import { runOperationalAlertTick, type OperationalAlertMailer, type OperationalAlertMessage } from "@/application/operational-alert-worker";

import { classifiedDocumentIssueFixture, classifiedSourceIssueFixture, clearOperationalAlertAllowanceFixture, failedCompanyDataExportFixture } from "./support/operational-alerts";

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
  for (const subscriber of subscribers.splice(0)) await deleteAccountFixture(subscriber.userId);
});

async function scenario(count = 2, locale: "cs" | "en" = "en", startAt?: string) {
  const admin = await promotedSuperAdministrator("Operational subscriber"); subscribers.push(admin);
  await setOperationalAlertPreference(admin.client, { enabled: true, locale });
  const company = await companyWithWaitingDocuments(count); companies.push(company);
  await removeAiConfigurationFixture(company.client, company.companyId);
  const messages: OperationalAlertMessage[] = [];
  const mailer: OperationalAlertMailer = { async send(message) { messages.push(message); return "accepted"; } };
  const scopes = new Set([company.companyId]);
  const start = startAt ? Date.parse(startAt) : Date.now() + 1000;
  const deliveries = async (recipient = admin.client) => {
    const result = await listOperationalAlertDeliveries(recipient);
    if (!result.ok) throw new Error(result.error);
    return result.value.filter(delivery => [...scopes].some(scope => delivery.rootKey.split(":").includes(scope)));
  };
  const observeMessages = async () => {
    // Other test files may leave legitimate active platform incidents. Observe
    // this scenario's public receipt IDs rather than assuming an empty platform.
    const result = await listOperationalAlertDeliveries(admin.client);
    if (result.ok) {
      const relevant = result.value.filter(delivery => [...scopes].some(scope => delivery.rootKey.split(":").includes(scope)));
      messages.splice(0, messages.length, ...messages.filter(message => relevant.some(delivery => message.messageId.includes(delivery.id))));
    }
  };
  const tick = async (seconds: number, transport = mailer) => {
    await runOperationalAlertTick(systemClient(), { mailer: transport,
      now: new Date(start + seconds * 1000).toISOString(), appOrigin: "https://ivat.example.test" });
    await observeMessages();
  };
  return { admin, company, messages, mailer, tick, deliveries, start, scopes, observeMessages };
}

/** Both roots and subscribers remain eligible. Select the target by public
 * pending receipt IDs so an unrelated delivery precedes it deterministically,
 * independently of random UUID allocation. The worker still drains every ID. */
async function scenarioAfterUnrelatedDelivery(startAt = new Date(Date.now() + 1000).toISOString()) {
  const candidates = [await scenario(1, "en", startAt), await scenario(1, "en", startAt)];
  await candidates[0].tick(0);
  const planned = await systemClient().rpc("reconcile_operational_alerts", {
    observed_at: new Date(Date.parse(startAt) + 300000).toISOString(),
  });
  if (planned.error) throw planned.error;
  const pairs = await Promise.all(candidates.map(async testCase => {
    const [receipt] = await testCase.deliveries();
    expect(receipt).toEqual(expect.objectContaining({ deliveryKind: "first", state: "pending" }));
    return { testCase, receipt };
  }));
  pairs.sort((a, b) => a.receipt.id < b.receipt.id ? -1 : 1);
  const [earlier, target] = pairs;
  expect((planned.data as string[]).indexOf(earlier.receipt.id)).toBeLessThan((planned.data as string[]).indexOf(target.receipt.id));
  return { ...target.testCase, earlier: earlier.testCase };
}

it("spaces reminders by literal elapsed twenty-four hours and never catches up missed windows", async () => {
  const { messages, tick, deliveries } = await scenario(1, "en", "2026-01-01T09:55:00Z");
  await tick(0);
  await tick(300); // First accepted at 2026-01-01T10:00:00Z.
  await tick(86699.999); // 2026-01-02T09:59:59.999Z.
  expect(messages).toHaveLength(1);
  await Promise.all([tick(86700), tick(86700)]); // 2026-01-02T10:00:00Z.
  expect(messages).toHaveLength(2);
  await tick(86700);
  expect(messages).toHaveLength(2);
  await tick(780300); // 2026-01-10T10:40:00Z, one opportunity after downtime.
  expect(messages).toHaveLength(3);
  await tick(780300);
  expect(messages).toHaveLength(3);
  const receipts = await deliveries();
  expect(new Set(receipts.map(receipt => receipt.episodeId)).size).toBe(1);
  expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "accepted", "accepted"]);
  expect(receipts.map(receipt => [receipt.deliveryKind, receipt.reminderOrdinal])).toEqual([["first", 0], ["reminder", 1], ["reminder", 2]]);
});

it("cancels a queued reminder at remediation commit and sends one episode-specific recovery before fresh recurrence grace", async () => {
  const { reprocessDocument } = await import("@/application/documents");
  const { company, start, messages, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await tick(0); await tick(300);
  const [first] = await deliveries();
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 86700000).toISOString() })).error).toBeNull();
  expect((await deliveries()).find(receipt => receipt.deliveryKind === "reminder")?.state).toBe("pending");
  expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
  expect((await deliveries()).find(receipt => receipt.deliveryKind === "reminder")).toEqual(expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) }));
  // Recurrence exists before recovery dispatch; recovery must describe only the old episode.
  expect(await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  await Promise.all([tick(90000), tick(90000)]);
  expect(messages).toHaveLength(2);
  expect(messages[1].subject).toBe("iVAT: operational incident episode ended");
  expect(messages[1].text).toContain("This incident episode ended. A later episode may still require attention.");
  expect(messages[1].text).not.toContain("Documents: 1");
  await tick(90299); expect(messages).toHaveLength(2);
  await tick(90300); expect(messages).toHaveLength(3);
  await tick(90300); expect(messages).toHaveLength(3);
  const receipts = await deliveries();
  expect(receipts.filter(receipt => receipt.episodeId === first.episodeId).map(receipt => receipt.deliveryKind).sort()).toEqual(["first", "recovery", "reminder"]);
  expect(receipts.filter(receipt => receipt.episodeId !== first.episodeId)).toEqual([expect.objectContaining({ deliveryKind: "first", state: "accepted" })]);
});

it("anchors first qualification to acceptance and later spacing to the genuine delayed dispatch clock", async () => {
  const { admin, messages, mailer, tick, deliveries, earlier, observeMessages } = await scenarioAfterUnrelatedDelivery("2026-01-01T09:55:00Z");
  await tick(0);
  let now = "2026-01-01T10:00:00Z";
  await runOperationalAlertTick(systemClient(), { appOrigin: "https://ivat.example.test", clock: () => now,
    mailer: { async send(message) {
      messages.push(message);
      if (message.to === admin.email && (await deliveries()).some(receipt => message.messageId.includes(receipt.id))) {
        now = "2026-01-01T11:00:00Z";
      }
      return "accepted";
    } } });
  await observeMessages();
  expect((await deliveries())[0]).toEqual(expect.objectContaining({ dispatchStartedAt: "2026-01-01T10:00:00+00:00", finishedAt: "2026-01-01T11:00:00+00:00" }));
  expect((await earlier.deliveries())[0]).toEqual(expect.objectContaining({ state: "accepted", dispatchStartedAt: "2026-01-01T10:00:00+00:00" }));
  await tick(90299.999); // Jan 2, 10:59:59.999: less than 24h since acceptance.
  expect(messages).toHaveLength(1);
  let samples = 0;
  await runOperationalAlertTick(systemClient(), { appOrigin: "https://ivat.example.test", mailer,
    clock: () => ++samples === 1 ? "2026-01-02T11:00:00Z" : "2026-01-02T12:00:00Z" });
  await observeMessages();
  expect(messages).toHaveLength(2);
  expect((await deliveries())[1]).toEqual(expect.objectContaining({ dispatchStartedAt: "2026-01-02T12:00:00+00:00" }));
  await tick(180299.999); // Jan 3, 11:59:59.999.
  expect(messages).toHaveLength(2);
  await tick(180300); // Jan 3, 12:00:00.
  expect(messages).toHaveLength(3);
});

it.each(["refused", "failed", "unknown"] as const)("never qualifies reminders or recovery from a %s first, even for another qualified subscriber", async outcome => {
  const { company, tick, messages, deliveries, earlier } = await scenarioAfterUnrelatedDelivery();
  const other = await promotedSuperAdministrator("Unqualified subscriber"); subscribers.push(other);
  expect(await setOperationalAlertPreference(other.client, { enabled: true, locale: "en" })).toEqual({ ok: true, value: null });
  const otherMessages: OperationalAlertMessage[] = [];
  const transport: OperationalAlertMailer = { async send(message) {
    if (message.to === other.email && (await deliveries(other.client)).some(receipt => message.messageId.includes(receipt.id))) {
      otherMessages.push(message);
      return outcome;
    }
    messages.push(message);
    return "accepted";
  } };
  await tick(0, transport); await tick(300, transport);
  await tick(86700, transport);
  expect(otherMessages).toHaveLength(1);
  expect((await earlier.deliveries())[0].state).toBe("accepted");
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  await tick(86701, transport);
  expect(otherMessages).toHaveLength(1);
  expect((await deliveries()).map(receipt => receipt.deliveryKind).sort()).toEqual(["first", "recovery", "reminder"]);
  const others = await listOperationalAlertDeliveries(other.client);
  if (!others.ok) throw new Error(others.error);
  expect(others.value.filter(receipt => receipt.rootKey.includes(company.companyId))).toEqual([expect.objectContaining({ deliveryKind: "first", state: outcome })]);
});

it.each(["accepted", "refused", "failed", "unknown", "throw"] as const)("keeps late first %s truthful after durable remediation and qualifies recovery only on acceptance", async outcome => {
  const { company, messages, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await tick(0);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const inFlight = tick(300, { async send(message) {
    messages.push(message); entered(); await held;
    if (outcome === "throw") throw new Error("private uncertain provider body");
    return outcome;
  } });
  await started;
  try {
    expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
    expect((await deliveries())[0]).toEqual(expect.objectContaining({ state: "sending", resolvedAt: expect.any(String) }));
  } finally { release(); await inFlight; }
  await Promise.all([tick(301), tick(301)]); await tick(302);
  expect(messages).toHaveLength(outcome === "accepted" ? 2 : 1);
  expect((await deliveries()).map(receipt => [receipt.deliveryKind, receipt.state])).toEqual(outcome === "accepted"
    ? [["first", "accepted"], ["recovery", "accepted"]] : [["first", outcome === "throw" ? "unknown" : outcome]]);
  expect(JSON.stringify(await deliveries())).not.toContain("private uncertain");
});

it.each(["accepted", "refused", "failed", "unknown", "throw"] as const)("counts a reminder %s attempt toward spacing and preserves one qualified recovery", async outcome => {
  const { company, tick, messages, deliveries } = await scenario(1);
  await tick(0); await tick(300);
  const transport: OperationalAlertMailer = { async send(message) {
    messages.push(message);
    if (outcome === "throw") throw new Error("private SMTP failure");
    return outcome;
  } };
  await Promise.all([tick(86700, transport), tick(86700, transport)]);
  expect(messages).toHaveLength(2);
  expect((await deliveries())[1].state).toBe(outcome === "throw" ? "unknown" : outcome);
  await tick(173099.999, transport); expect(messages).toHaveLength(2);
  await tick(173100, transport);
  expect(messages).toHaveLength(outcome === "unknown" || outcome === "throw" ? 2 : 3);
  await tick(864300, transport);
  expect(messages).toHaveLength(outcome === "unknown" || outcome === "throw" ? 2 : 4);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  const before = messages.length;
  await tick(864301); await tick(864302);
  expect(messages).toHaveLength(before + 1);
  expect((await deliveries()).filter(receipt => receipt.deliveryKind === "recovery")).toEqual([expect.objectContaining({ state: "accepted" })]);
});

for (const deliveryKind of ["reminder", "recovery"] as const) {
  it.each(["opt_out", "role_removed", "deactivated", "unverified", "email_change"] as const)(`reauthorizes a queued ${deliveryKind} after %s`, async reason => {
    const { admin, company, start, tick, messages, deliveries } = await scenario(1);
    await tick(0); await tick(300);
    if (deliveryKind === "recovery") {
      const [document] = await listCompanyDocuments(company.client, company.companyId);
      expect(await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
      expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
    }
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 86700000).toISOString() })).error).toBeNull();
    const pending = (await deliveries()).find(receipt => receipt.deliveryKind === deliveryKind)!;
    expect(pending.state).toBe("pending");
    if (reason === "opt_out") await setOperationalAlertPreference(admin.client, { enabled: false, locale: "en" });
    if (reason === "role_removed") await revokeSuperAdministratorFixture(admin.userId);
    if (reason === "deactivated") await deactivateAccountFixture(admin.userId);
    if (reason === "unverified" || reason === "email_change") {
      const { alertAccountFixture } = await import("./support/operational-alerts");
      await alertAccountFixture(admin.userId, reason);
    }
    // The actual worker rechecks at claim; stale planned IDs supply no authority.
    await tick(86700);
    expect(messages).toHaveLength(1);
    expect((await systemClient().rpc("claim_operational_alert", { target_delivery_id: pending.id, observed_at: new Date(start + 86701000).toISOString() })).data).toBeNull();
    if (reason !== "role_removed") {
      expect((await deliveries()).find(receipt => receipt.id === pending.id)?.state).toBe("cancelled");
    } else {
      expect(await listOperationalAlertDeliveries(admin.client)).toEqual({ ok: false, error: "forbidden" });
    }
  });

  it(`uses the current verified address and CS locale for a queued ${deliveryKind}`, async () => {
    const { admin, company, start, tick, messages, deliveries } = await scenario(1);
    await tick(0); await tick(300);
    if (deliveryKind === "recovery") {
      const [document] = await listCompanyDocuments(company.client, company.companyId);
      await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    }
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + 86700000).toISOString() })).error).toBeNull();
    expect((await deliveries()).find(receipt => receipt.deliveryKind === deliveryKind)?.state).toBe("pending");
    await setVerifiedAccountEmailFixture(admin.userId, `changed-${admin.userId}@example.test`);
    expect(await setOperationalAlertPreference(admin.client, { enabled: true, locale: "cs" })).toEqual({ ok: true, value: null });
    await tick(86700);
    expect(messages).toHaveLength(2);
    expect(messages[1].to).toBe(`changed-${admin.userId}@example.test`);
    expect(messages[1].subject).toBe(deliveryKind === "reminder" ? "iVAT: trvající provozní blokace" : "iVAT: provozní incidentní epizoda skončila");
    expect(messages[1].html).toContain(deliveryKind === "reminder" ? "Tato incidentní epizoda stále blokuje kritickou práci" : "Pozdější epizoda může stále vyžadovat zásah.");
    expect(messages[1].text).toContain("https://ivat.example.test/platform/ai-settings");
  });

  it.each(["accepted", "refused", "failed", "unknown", "throw"] as const)(`records ${deliveryKind} %s without retrying its receipt`, async outcome => {
    const { company, tick, messages, deliveries } = await scenario(1);
    await tick(0); await tick(300);
    if (deliveryKind === "recovery") {
      const [document] = await listCompanyDocuments(company.client, company.companyId);
      await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    }
    const transport: OperationalAlertMailer = { async send(message) {
      messages.push(message);
      if (outcome === "throw") throw new Error("private provider response");
      return outcome;
    } };
    await tick(86700, transport); await tick(86701, transport);
    expect(messages).toHaveLength(2);
    const receipt = (await deliveries()).find(receipt => receipt.deliveryKind === deliveryKind)!;
    expect(receipt.state).toBe(outcome === "throw" ? "unknown" : outcome);
    expect(messages[1].messageId).toContain(receipt.id);
    if (deliveryKind === "recovery") {
      await tick(259500, transport); expect(messages).toHaveLength(2);
      expect((await deliveries()).filter(receipt => receipt.deliveryKind === "recovery")).toHaveLength(1);
    }
    expect(JSON.stringify(await deliveries())).not.toContain("private provider");
  });
}

it.each(["first", "reminder", "recovery"] as const)("keeps interrupted %s unknown without blind resend and accepts only its original late token", async deliveryKind => {
  const { company, start, tick, messages, deliveries } = await scenario(1);
  await tick(0);
  if (deliveryKind !== "first") await tick(300);
  if (deliveryKind === "recovery") {
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  }
  const at = deliveryKind === "first" ? 300 : 86700;
  const observed = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const system = systemClient();
  expect((await system.rpc("reconcile_operational_alerts", { observed_at: observed(at) })).error).toBeNull();
  const pending = (await deliveries()).find(receipt => receipt.deliveryKind === deliveryKind)!;
  const claim = await system.rpc("claim_operational_alert", { target_delivery_id: pending.id, observed_at: observed(at) });
  expect(claim.error).toBeNull(); expect(claim.data).not.toBeNull();
  const token = (claim.data as { claimToken: string }).claimToken;
  await tick(at + 119.999);
  expect((await deliveries()).find(receipt => receipt.id === pending.id)?.state).toBe("sending");
  await tick(at + 120);
  expect((await deliveries()).find(receipt => receipt.id === pending.id)?.state).toBe("unknown");
  const sent = messages.length;
  await tick(at + 86400); expect(messages).toHaveLength(sent);
  expect((await system.rpc("finish_operational_alert", { target_delivery_id: pending.id, target_claim_token: crypto.randomUUID(), transport_outcome: "accepted", observed_at: observed(at + 86401) })).error).toBeNull();
  expect((await deliveries()).find(receipt => receipt.id === pending.id)?.state).toBe("unknown");
  if (deliveryKind === "first") {
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  }
  expect((await system.rpc("finish_operational_alert", { target_delivery_id: pending.id, target_claim_token: token, transport_outcome: "accepted", observed_at: observed(at + 86402) })).error).toBeNull();
  expect((await system.rpc("finish_operational_alert", { target_delivery_id: pending.id, target_claim_token: token, transport_outcome: "refused", observed_at: observed(at + 86403) })).error).toBeNull();
  expect((await deliveries()).find(receipt => receipt.id === pending.id)?.state).toBe("accepted");
  await tick(at + 86403);
  expect(messages).toHaveLength(sent + (deliveryKind === "recovery" ? 0 : 1));
  if (deliveryKind === "first") expect((await deliveries()).find(receipt => receipt.deliveryKind === "recovery")?.state).toBe("accepted");
});

it("never inherits an earlier episode's accepted first when a recurrent first is uncertain", async () => {
  const { reprocessDocument } = await import("@/application/documents");
  const { company, messages, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await tick(0); await tick(300);
  const [old] = await deliveries();
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  await tick(301); expect(messages).toHaveLength(2);
  await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: document.id });
  await tick(302); await tick(601); expect(messages).toHaveLength(2);
  await tick(602, { async send(message) { messages.push(message); return "unknown"; } });
  expect(messages).toHaveLength(3);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
  await tick(603); await tick(86702);
  expect(messages).toHaveLength(3);
  expect((await deliveries()).filter(receipt => receipt.episodeId !== old.episodeId)).toEqual([
    expect.objectContaining({ deliveryKind: "first", state: "unknown", resolvedAt: expect.any(String) }),
  ]);
});

it.each(["cs", "en"] as const)("sends first, reminder and recovery through the real local SMTP adapter in %s", async locale => {
  const { localSmtpCapture } = await import("./support/smtp-capture");
  const { smtpOperationalAlertMailer } = await import("@/mail/smtp-operational-alert-mailer");
  const capture = await localSmtpCapture("accepted");
  try {
    const { company, tick, deliveries } = await scenario(1, locale);
    const mailer = smtpOperationalAlertMailer({ host: "127.0.0.1", port: capture.port, sender: "noreply@example.test", localCapture: true });
    await tick(0, mailer); await tick(300, mailer); await tick(86700, mailer);
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("needs_review");
    await tick(86701, mailer); await tick(86702, mailer);
    const receipts = await deliveries();
    expect(receipts.map(receipt => [receipt.deliveryKind, receipt.state]).sort()).toEqual([
      ["first", "accepted"], ["recovery", "accepted"], ["reminder", "accepted"],
    ]);
    const own = capture.messages.filter(message => receipts.some(receipt => message.includes(receipt.id)));
    expect(own).toHaveLength(3);
    for (const message of own) {
      expect(message).toContain("Content-Type: text/plain; charset=utf-8");
      expect(message).toContain("Content-Type: text/html; charset=utf-8");
    }
  } finally { await capture.close(); }
});

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
  if (reason === "deactivated") await deactivateAccountFixture(admin.userId);
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
  await setVerifiedAccountEmailFixture(admin.userId, `current-${admin.userId}@example.test`);
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
  expect(await listOperationalAlertDeliveries(weak)).toEqual({ ok: false, error: "forbidden" });
  expect(await listOperationalAlertDeliveries(ordinary.client)).toEqual({ ok: false, error: "forbidden" });
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
      await classifiedDocumentIssueFixture(document.id, { classification: "invalid_credentials", state: "waiting_for_platform", configurationId: configuration.value.id });
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
  const [first] = await deliveries();
  for (const document of await listCompanyDocuments(company.client, company.companyId)) {
    await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  }
  expect((await listCompanyDocuments(company.client, company.companyId)).every(document => document.status === "needs_review")).toBe(true);
  await tick(86700);
  expect(messages).toHaveLength(2);
  expect(messages[1].text).toContain("Companies: 1"); expect(messages[1].text).toContain("Documents: 3");
  expect((await deliveries()).map(receipt => [receipt.episodeId, receipt.deliveryKind, receipt.resolvedAt])).toEqual([
    [first.episodeId, "first", null], [first.episodeId, "reminder", null],
  ]);
  for (const document of await listCompanyDocuments(second.client, second.companyId)) {
    await startManualDocumentReview(second.client, { companyId: second.companyId, documentId: document.id });
  }
  expect((await listCompanyDocuments(second.client, second.companyId)).every(document => document.status === "needs_review")).toBe(true);
  await tick(86701); await tick(86702);
  expect(messages).toHaveLength(3);
  expect((await deliveries()).filter(receipt => receipt.deliveryKind === "recovery")).toEqual([expect.objectContaining({ episodeId: first.episodeId, state: "accepted" })]);
});

it("keeps transient provider warnings and exhausted allowance without waiting work in-app", async () => {
  const { setCompanyAiProcessingAllowance } = await import("@/application/ai-processing-allowance");
  const { admin, company, tick, messages } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await classifiedDocumentIssueFixture(document.id, { classification: "provider_unavailable", state: "waiting_for_platform" });
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
  await classifiedDocumentIssueFixture(document.id, { classification, state: "terminal" });
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

it.each([
  ["independent", "first"], ["overlapping", "first"],
  ["independent", "reminder"], ["overlapping", "reminder"],
] as const)("ends a shared incident at concurrent remediation commits (%s, pending %s) and requires full fresh grace for recurrence", async (interleaving, deliveryKind) => {
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
    await classifiedDocumentIssueFixture(document.id, { classification: "invalid_credentials", state: "waiting_for_platform", configurationId: configuration.value.id });
  }
  await tick(0);
  if (deliveryKind === "reminder") await tick(300);
  const due = deliveryKind === "reminder" ? 86700 : 300;
  expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + due * 1000).toISOString() })).error).toBeNull();
  const oldDelivery = (await deliveries()).find(receipt => receipt.deliveryKind === deliveryKind)!;
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
    expect((await systemClient().rpc("reconcile_operational_alerts", { observed_at: new Date(start + due * 1000).toISOString() })).error).toBeNull();
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
  expect((await deliveries()).find(receipt => receipt.id === oldDelivery.id)).toEqual(expect.objectContaining({ state: "cancelled", resolvedAt: expect.any(String) }));
  await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: documents[0].id });
  await classifiedDocumentIssueFixture(documents[0].id, { classification: "invalid_credentials", state: "waiting_for_platform", configurationId: configuration.value.id });
  const afterRecovery = deliveryKind === "reminder" ? 2 : 0;
  await tick(due + 1); await tick(due + 300); expect(messages).toHaveLength(afterRecovery);
  await tick(due + 301); expect(messages).toHaveLength(afterRecovery + 1);
  expect((await deliveries()).filter(receipt => receipt.episodeId !== oldDelivery.episodeId)).toEqual([
    expect.objectContaining({ deliveryKind: "first", state: "accepted", impact: { companies: 1, documents: 1, sourceFiles: 0, exportJobs: 0 } }),
  ]);
  expect((await deliveries()).filter(receipt => receipt.episodeId === oldDelivery.episodeId && receipt.deliveryKind === "recovery")).toHaveLength(deliveryKind === "reminder" ? 1 : 0);
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
  await classifiedDocumentIssueFixture(blocked.id, { classification: "invalid_credentials", state: "waiting_for_platform", configurationId: configurationId });
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
  await tick(598); expect(messages).toHaveLength(2);
  expect(messages[1].subject).toBe("iVAT: operational incident episode ended");
  await tick(599); expect(messages).toHaveLength(3);
});

it("cancels a Source File incident immediately when manual Source recovery resolves its work", async () => {
  const { uploadSourceFile, startManualSourceReview, getSourceFile } = await import("@/application/source-files");
  const { fixtureFile } = await import("./support/files");
  const { company, start, tick, deliveries } = await scenario(1);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
  const source = await uploadSourceFile(company.client, { async send() {} }, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!source.ok) throw new Error(source.error);
  await classifiedSourceIssueFixture(source.value.id, { classification: "configuration_missing", state: "waiting_for_platform" });
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
    await failedCompanyDataExportFixture(exported.value.exportId);
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
    await tick(600); expect(messages).toHaveLength(4);
    expect((await deliveries()).filter(delivery => delivery.deliveryKind === "recovery")).toHaveLength(2);
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
