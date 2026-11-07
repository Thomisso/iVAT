import { strFromU8, unzipSync } from "fflate";
import { exportCompanyData, getCompanyDataExportStatus, softDeleteCompany } from "@/application/company-deletion";
import { testWorker } from "./support/worker";
import { expect, it } from "vitest";
import { archiveCounterparty, createCounterparty, deleteCounterparty, getCounterparty, listCounterparties, restoreCounterparty, updateCounterparty } from "@/application/counterparties";
import { createCompany, getCompany } from "@/application/companies";
import { anonymousClient, provisionedUser } from "./support/clients";
import { directoryMutationAfterCompanyDeletion } from "./support/counterparties";
import { listAuditEvents } from "@/application/audit";
import { promotedSuperAdministrator } from "./support/platform";
import { administratorWithCompany, companyMember, companyDetails } from "./support/fixtures";

it("lets a Company User create and retrieve one Counterparty in both directory roles", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createCounterparty(user.client, {
    companyId: company.companyId,
    name: "  Novák dodavatel a odběratel  ",
    ico: "2708 2440",
    vatId: " cz 27082440 ",
    street: " Vinohradská 12 ",
    city: " Praha ",
    postalCode: " 120 00 ",
    countryCode: "cz",
    supplier: true,
    customer: true,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(await getCounterparty(user.client, company.companyId, created.value.id)).toEqual({
    id: created.value.id,
    organizationId: company.organizationId,
    companyId: company.companyId,
    name: "Novák dodavatel a odběratel",
    ico: "27082440",
    vatId: "CZ27082440",
    street: "Vinohradská 12",
    city: "Praha",
    postalCode: "120 00",
    countryCode: "CZ",
    supplier: true,
    customer: true,
    archivedAt: null,
  });
  expect((await listCounterparties(company.client, company.companyId)).entries).toEqual([
    expect.objectContaining({ id: created.value.id, supplier: true, customer: true }),
  ]);
});


it("lets every Company Role edit and audits creation and actual changes", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const administrator = await companyMember(company, "administrator");
  const superAdmin = await promotedSuperAdministrator("Directory platform operator");
  const created = await createCounterparty(user.client, { companyId: company.companyId, name: "Original", supplier: true, customer: false });
  if (!created.ok) throw new Error(created.error);
  for (const [actor, name] of [[user, "User edit"], [administrator, "Administrator edit"], [superAdmin, "SuperAdmin edit"]] as const) {
    expect(await updateCounterparty(actor.client, { companyId: company.companyId, id: created.value.id, name, supplier: true, customer: true })).toEqual({ ok: true, value: null });
    expect(await getCounterparty(user.client, company.companyId, created.value.id)).toEqual(expect.objectContaining({ name, supplier: true, customer: true }));
  }
  for (const actor of [user, administrator, superAdmin]) {
    const createdByRole = await createCounterparty(actor.client, { companyId: company.companyId, name: "Created by Role", supplier: false, customer: true });
    expect(createdByRole.ok).toBe(true);
    if (createdByRole.ok) expect((await getCounterparty(user.client, company.companyId, createdByRole.value.id))?.customer).toBe(true);
  }
  expect(await updateCounterparty(superAdmin.client, { companyId: company.companyId, id: created.value.id, name: "SuperAdmin edit", supplier: true, customer: true })).toEqual({ ok: true, value: null });
  const events = (await listAuditEvents(company.client, company.organizationId)).filter(event => event.targetId === created.value.id);
  expect(events.map(event => [event.action, event.actorUserId])).toEqual([
    ["counterparty.created", user.userId], ["counterparty.updated", user.userId],
    ["counterparty.updated", administrator.userId], ["counterparty.updated", superAdmin.userId],
  ]);
});


it("searches normalized identifiers and names, combines both roles, and pages the directory", async () => {
  const company = await administratorWithCompany();
  for (const entry of [
    { name: "Alpha", ico: "27082440", vatId: "CZ27082440", supplier: true, customer: false },
    { name: "Beta", ico: "12345679", vatId: "SK1234567890", supplier: false, customer: true },
    { name: "Both", supplier: true, customer: true },
  ]) {
    const created = await createCounterparty(company.client, { companyId: company.companyId, ...entry });
    if (!created.ok) throw new Error(created.error);
  }
  expect((await listCounterparties(company.client, company.companyId, { search: "ALP" })).entries.map(entry => entry.name)).toEqual(["Alpha"]);
  expect((await listCounterparties(company.client, company.companyId, { search: "2708\u00a02440" })).entries.map(entry => entry.name)).toEqual(["Alpha"]);
  expect((await listCounterparties(company.client, company.companyId, { search: "sk 1234567890" })).entries.map(entry => entry.name)).toEqual(["Beta"]);
  expect((await listCounterparties(company.client, company.companyId, { role: "supplier" })).entries.map(entry => entry.name)).toEqual(["Alpha", "Both"]);
  expect((await listCounterparties(company.client, company.companyId, { role: "customer" })).entries.map(entry => entry.name)).toEqual(["Beta", "Both"]);
  expect(await listCounterparties(company.client, company.companyId, { page: 2, pageSize: 2 })).toEqual({
    entries: [expect.objectContaining({ name: "Both" })], total: 3, page: 2, pageSize: 2, pageCount: 2,
  });
  expect((await listCounterparties(company.client, company.companyId, { search: "%,)_" })).entries).toEqual([]);
});


it("isolates Company directories through commands and direct authenticated queries", async () => {
  const company = await administratorWithCompany();
  const member = await companyMember(company);
  const outsider = await provisionedUser("Other Organization");
  const second = await createCompany(company.client, { organizationId: company.organizationId, ...companyDetails() });
  if (!second.ok) throw new Error(second.error);
  const entry = { name: "Private supplier", ico: "27082440", supplier: true, customer: false };
  const created = await createCounterparty(company.client, { companyId: second.value.id, ...entry });
  if (!created.ok) throw new Error(created.error);
  for (const actor of [member, outsider]) {
    expect(await getCounterparty(actor.client, second.value.id, created.value.id)).toBeNull();
    expect((await listCounterparties(actor.client, second.value.id)).entries).toEqual([]);
    expect(await createCounterparty(actor.client, { companyId: second.value.id, ...entry, ico: "12345679" })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateCounterparty(actor.client, { companyId: second.value.id, id: created.value.id, ...entry, name: "Intrusion" })).toEqual({ ok: false, error: "forbidden" });
    for (const command of [archiveCounterparty, restoreCounterparty, deleteCounterparty]) {
      expect(await command(actor.client, { companyId: second.value.id, id: created.value.id })).toEqual({ ok: false, error: "forbidden" });
      expect(await command(actor.client, { companyId: company.companyId, id: created.value.id })).toEqual({ ok: false, error: "forbidden" });
    }
    for (const name of ["archive_counterparty", "restore_counterparty", "delete_counterparty"] as const) {
      const direct = await actor.client.rpc(name, { target_company_id: second.value.id, target_counterparty_id: created.value.id });
      expect(direct.error?.code).toBe("42501");
    }

    const directRead = await actor.client.from("counterparty").select("id").eq("id", created.value.id);
    expect(directRead.data).toEqual([]);
    const directWrite = await actor.client.from("counterparty").update({ name: "Intrusion" }).eq("id", created.value.id).select("id");
    expect(directWrite.error).toBeNull();
    expect(directWrite.data).toEqual([]);
    const directInsert = await actor.client.from("counterparty").insert({ organization_id: company.organizationId, company_id: second.value.id, name: "Intrusion", supplier: true });
    expect(directInsert.error?.code).toBe("42501");
  }
  expect(await createCounterparty(member.client, { companyId: company.companyId, ...entry })).toEqual({ ok: true, value: { id: expect.any(String) } });
  expect((await getCounterparty(company.client, second.value.id, created.value.id))?.name).toBe("Private supplier");
  const scopeRewrite = await company.client.from("counterparty").update({ company_id: company.companyId }).eq("id", created.value.id);
  expect(scopeRewrite.error?.code).toBe("42501");
  const directArchive = await company.client.from("counterparty").update({ archived_at: "2026-11-01T00:00:00Z" }).eq("id", created.value.id);
  expect(directArchive.error?.code).toBe("42501");
  for (const name of ["archive_counterparty", "restore_counterparty", "delete_counterparty"] as const) {
    const direct = await anonymousClient().rpc(name, { target_company_id: second.value.id, target_counterparty_id: created.value.id });
    expect(direct.error?.code).toBe("42501");
  }

});

it.each(["ico", "vatId"] as const)("prevents concurrent duplicate %s identities, while equal names without IDs remain distinct", async identifier => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const values = { companyId: company.companyId, name: "Same name", supplier: true, customer: false };
  const attempts = await Promise.all([
    createCounterparty(company.client, { ...values, [identifier]: identifier === "ico" ? "2708 2440" : "cz 27082440" }),
    createCounterparty(user.client, { ...values, [identifier]: identifier === "ico" ? "27082440" : "CZ27082440" }),
  ]);
  expect(attempts.filter(result => result.ok)).toHaveLength(1);
  expect(attempts.filter(result => !result.ok)).toEqual([{ ok: false, error: "counterparty_identity_taken" }]);
  expect((await listCounterparties(user.client, company.companyId)).total).toBe(1);
  // A direct authenticated caller cannot evade identity normalization in the database.
  const direct = await user.client.rpc("create_counterparty", {
    target_company_id: company.companyId, counterparty_name: "Direct duplicate",
    counterparty_ico: identifier === "ico" ? "2708 2440" : "",
    counterparty_vat_id: identifier === "vatId" ? "cz 27082440" : "",
    counterparty_street: "", counterparty_city: "", counterparty_postal_code: "",
    counterparty_country_code: "", counterparty_supplier: true, counterparty_customer: false,
  });
  expect(direct.error?.code).toBe("23505");
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "counterparty.created")).toHaveLength(1);
  for (let i = 0; i < 2; i++) expect((await createCounterparty(user.client, values)).ok).toBe(true);
  expect((await listCounterparties(user.client, company.companyId)).total).toBe(3);
});

it("keeps archived IDs reserved and refuses edits colliding with either identifier", async () => {
  const company = await administratorWithCompany();
  const values = { companyId: company.companyId, name: "Reserved identity", ico: "27082440", vatId: "CZ27082440", supplier: true, customer: false };
  const original = await createCounterparty(company.client, values);
  if (!original.ok) throw new Error(original.error);
  const other = await createCounterparty(company.client, { ...values, name: "Other identity", ico: "12345679", vatId: "SK1234567890" });
  if (!other.ok) throw new Error(other.error);
  expect(await updateCounterparty(company.client, { ...values, id: other.value.id, vatId: "SK1234567890" })).toEqual({ ok: false, error: "counterparty_identity_taken" });
  expect(await updateCounterparty(company.client, { ...values, id: other.value.id, ico: "12345679" })).toEqual({ ok: false, error: "counterparty_identity_taken" });
  expect(await archiveCounterparty(company.client, { companyId: company.companyId, id: original.value.id })).toEqual({ ok: true, value: null });
  expect((await listCounterparties(company.client, company.companyId)).entries.map(entry => entry.name)).toEqual(["Other identity"]);
  expect((await getCounterparty(company.client, company.companyId, original.value.id))?.archivedAt).not.toBeNull();
  expect(await createCounterparty(company.client, { ...values, ico: "2708 2440", vatId: "cz 27082440" })).toEqual({ ok: false, error: "counterparty_identity_taken" });
});

it.each([
  [{ name: " " }, "name_required"],
  [{ name: "x".repeat(256) }, "name_too_long"],
  [{ ico: "123" }, "invalid_ico"],
  [{ vatId: "CZ!invalid" }, "counterparty_invalid_vat_id"],
  [{ countryCode: "CZE" }, "invalid_country_code"],
  [{ supplier: false }, "counterparty_role_required"],
] as const)("refuses invalid directory input %o without a row", async (change, error) => {
  const company = await administratorWithCompany();
  expect(await createCounterparty(company.client, { companyId: company.companyId, name: "Counterparty", supplier: true, customer: false, ...change })).toEqual({ ok: false, error });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
});


it("preserves the directory in Company archives and invalidates an export after directory changes", async () => {
  const company = await administratorWithCompany();
  const created = await createCounterparty(company.client, { companyId: company.companyId, name: "Exported supplier", ico: "27082440", supplier: true, customer: true });
  if (!created.ok) throw new Error(created.error);
  const worker = testWorker();
  const exported = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  const archive = unzipSync(exported.value.bytes);
  expect(archive["counterparties.json"]).toBeDefined();
  expect(JSON.parse(strFromU8(archive["counterparties.json"]))).toEqual([
    expect.objectContaining({ id: created.value.id, name: "Exported supplier", ico: "27082440", supplier: true, customer: true, archivedAt: null }),
  ]);
  expect(await getCompanyDataExportStatus(company.client, { companyId: company.companyId, exportId: exported.value.exportId })).toEqual({ ok: true, value: "completed" });
  expect(await updateCounterparty(company.client, { companyId: company.companyId, id: created.value.id, name: "Changed after export", supplier: true, customer: false })).toEqual({ ok: true, value: null });
  expect(await getCompanyDataExportStatus(company.client, { companyId: company.companyId, exportId: exported.value.exportId })).toEqual({ ok: true, value: "stale" });
});


it.each(["create", "update", "archive", "restore", "delete"] as const)("refuses a concurrent directory %s after Company deletion wins its lock", async operation => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const values = { companyId: company.companyId, name: "Before deletion", supplier: true, customer: false };
  let counterpartyId = "";
  if (operation !== "create") {
    const created = await createCounterparty(user.client, values);
    if (!created.ok) throw new Error(created.error);
    counterpartyId = created.value.id;
    if (operation === "restore") expect((await archiveCounterparty(user.client, { companyId: company.companyId, id: counterpartyId })).ok).toBe(true);
  }
  const worker = testWorker();
  const exported = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  const mutation = () => {
    const target = { companyId: company.companyId, id: counterpartyId };
    if (operation === "archive") return archiveCounterparty(user.client, target);
    if (operation === "restore") return restoreCounterparty(user.client, target);
    if (operation === "delete") return deleteCounterparty(user.client, target);
    return operation === "create" ? createCounterparty(user.client, { ...values, name: "After deletion" })
      : updateCounterparty(user.client, { ...values, id: counterpartyId, name: "After deletion" });
  };
  const outcomes = await directoryMutationAfterCompanyDeletion(company.companyId,
    () => softDeleteCompany(company.client, { companyId: company.companyId, exportId: exported.value.exportId }),
    mutation,
  );
  expect(outcomes).toEqual([
    { status: "fulfilled", value: { ok: true, value: { sourceFileCount: 0, documentCount: 0, approvedDocumentCount: 0, periodLockCount: 0 } } },
    { status: "fulfilled", value: { ok: false, error: "forbidden" } },
  ]);
  expect(await getCompany(company.client, company.companyId)).toBeNull();
  const changes = (await listAuditEvents(company.client, company.organizationId)).filter(event => event.action.startsWith("counterparty."));
  expect(changes.map(event => event.action)).toEqual(operation === "create" ? [] : operation === "restore" ? ["counterparty.created", "counterparty.archived"] : ["counterparty.created"]);
});


it("lets a Company User archive a Counterparty while preserving its details and hiding it from ordinary selection", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createCounterparty(user.client, {
    companyId: company.companyId, name: "Lifecycle supplier", ico: "27082440",
    supplier: true, customer: true,
  });
  if (!created.ok) throw new Error(created.error);
  expect(await archiveCounterparty(user.client, { companyId: company.companyId, id: created.value.id }))
    .toEqual({ ok: true, value: null });
  expect(await getCounterparty(user.client, company.companyId, created.value.id)).toEqual(expect.objectContaining({
    id: created.value.id, name: "Lifecycle supplier", ico: "27082440",
    supplier: true, customer: true, archivedAt: expect.any(String),
  }));
  expect((await listCounterparties(user.client, company.companyId, { search: "Lifecycle" })).entries).toEqual([]);
  const events = (await listAuditEvents(company.client, company.organizationId))
    .filter(event => event.targetId === created.value.id);
  expect(events.map(event => [event.action, event.actorUserId])).toEqual([
    ["counterparty.created", user.userId], ["counterparty.archived", user.userId],
  ]);
});


it("finds archived Counterparties and restores the same identity without repeating audit for unchanged state", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createCounterparty(user.client, {
    companyId: company.companyId, name: "Restore supplier", ico: "27082440", vatId: "CZ27082440", supplier: true, customer: true,
  });
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, id: created.value.id };
  expect(await archiveCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  expect(await archiveCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  const archived = await getCounterparty(user.client, company.companyId, created.value.id);
  expect((await listCounterparties(user.client, company.companyId, { state: "archived", search: "2708 2440", role: "customer" })).entries)
    .toEqual([archived]);
  expect(await restoreCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  expect(await restoreCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  expect((await listCounterparties(user.client, company.companyId)).entries).toEqual([{ ...archived, archivedAt: null }]);
  expect((await listCounterparties(user.client, company.companyId, { state: "archived" })).entries).toEqual([]);
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.targetId === target.id)
    .map(event => [event.action, event.actorUserId])).toEqual([
      ["counterparty.created", user.userId], ["counterparty.archived", user.userId], ["counterparty.restored", user.userId],
    ]);
});


it("lets a Company User delete an unused Counterparty and retains its audited identity", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createCounterparty(user.client, { companyId: company.companyId, name: "Unused supplier", ico: "27082440", supplier: true, customer: false });
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, id: created.value.id };
  expect(await archiveCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  expect(await deleteCounterparty(user.client, target)).toEqual({ ok: true, value: null });
  expect(await getCounterparty(user.client, company.companyId, target.id)).toBeNull();
  expect((await listCounterparties(user.client, company.companyId)).entries).toEqual([]);
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.targetId === target.id)
    .map(event => [event.action, event.actorUserId, event.payload])).toEqual([
      ["counterparty.created", user.userId, expect.objectContaining({ name: "Unused supplier", ico: "27082440" })],
      ["counterparty.archived", user.userId, expect.objectContaining({ archivedAt: expect.any(String) })],
      ["counterparty.deleted", user.userId, expect.objectContaining({ name: "Unused supplier", ico: "27082440" })],
    ]);
});


it("gives all effective Company Roles the same lifecycle capabilities with actor audit", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const administrator = await companyMember(company, "administrator");
  const superAdmin = await promotedSuperAdministrator("Lifecycle platform operator");
  for (const actor of [user, administrator, company, superAdmin]) {
    const created = await createCounterparty(actor.client, { companyId: company.companyId, name: "Role lifecycle", supplier: true, customer: true });
    if (!created.ok) throw new Error(created.error);
    const target = { companyId: company.companyId, id: created.value.id };
    expect(await archiveCounterparty(actor.client, target)).toEqual({ ok: true, value: null });
    expect((await getCounterparty(user.client, company.companyId, target.id))?.archivedAt).not.toBeNull();
    expect(await restoreCounterparty(actor.client, target)).toEqual({ ok: true, value: null });
    expect((await getCounterparty(user.client, company.companyId, target.id))?.archivedAt).toBeNull();
    expect(await deleteCounterparty(actor.client, target)).toEqual({ ok: true, value: null });
    expect(await getCounterparty(user.client, company.companyId, target.id)).toBeNull();
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.targetId === target.id)
      .map(event => [event.action, event.actorUserId])).toEqual([
        ["counterparty.created", actor.userId], ["counterparty.archived", actor.userId],
        ["counterparty.restored", actor.userId], ["counterparty.deleted", actor.userId],
      ]);
  }
});

it("includes archived entries in Company exports and invalidates exports only for actual lifecycle changes", async () => {
  const company = await administratorWithCompany();
  const created = await createCounterparty(company.client, { companyId: company.companyId, name: "Archived export", ico: "27082440", supplier: true, customer: true });
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, id: created.value.id };
  const worker = testWorker();
  for (const operation of ["archive", "restore", "delete"] as const) {
    const exported = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect(await worker.runJobs()).toEqual([]);
    const entries = JSON.parse(strFromU8(unzipSync(exported.value.bytes)["counterparties.json"]));
    expect(entries).toEqual([expect.objectContaining({ id: target.id, ico: "27082440", archivedAt: operation === "restore" ? expect.any(String) : null })]);
    const status = { companyId: company.companyId, exportId: exported.value.exportId };
    expect(await getCompanyDataExportStatus(company.client, status)).toEqual({ ok: true, value: "completed" });
    if (operation === "restore") {
      expect((await archiveCounterparty(company.client, target)).ok).toBe(true);
      expect(await getCompanyDataExportStatus(company.client, status)).toEqual({ ok: true, value: "completed" });
    }
    const command = operation === "archive" ? archiveCounterparty : operation === "restore" ? restoreCounterparty : deleteCounterparty;
    expect(await command(company.client, target)).toEqual({ ok: true, value: null });
    expect(await getCompanyDataExportStatus(company.client, status)).toEqual({ ok: true, value: "stale" });
  }
});
