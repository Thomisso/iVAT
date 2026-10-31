import { describe, expect, it } from "vitest";
import { listAuditActors, listAuditCompanies, listAuditEventPage, listAuditEvents } from "@/application/audit";
import { listMyCompanies } from "@/application/companies";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import { listMemberships, removeMembership } from "@/application/memberships";
import { provisionedAccount, provisionedUser, uniqueEmail } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { administratorWithCompany, companyMember } from "./support/fixtures";

describe("audit log", () => {
  it("paginates an Organization's events newest first", async () => {
    const { client, organizationId } = await administratorWithCompany();

    const first = await listAuditEventPage(client, organizationId, { page: 1, pageSize: 2 });
    const second = await listAuditEventPage(client, organizationId, { page: 2, pageSize: 2 });
    const third = await listAuditEventPage(client, organizationId, { page: 3, pageSize: 2 });

    expect(first).toEqual({
      events: [
        expect.objectContaining({
          action: "company.setup_changed",
          payload: { state: "completed", step: "filing_frequency" },
        }),
        expect.objectContaining({ action: "reporting_year.generated" }),
      ],
      page: 1,
      pageSize: 2,
      total: 5,
      pageCount: 3,
    });
    expect(second).toEqual({
      events: [
        expect.objectContaining({
          action: "company.setup_changed",
          payload: { state: "completed", step: "identity" },
        }),
        expect.objectContaining({ action: "company.created" }),
      ],
      page: 2,
      pageSize: 2,
      total: 5,
      pageCount: 3,
    });
    expect(third).toEqual({
      events: [expect.objectContaining({ action: "user.signed_up" })],
      page: 3,
      pageSize: 2,
      total: 5,
      pageCount: 3,
    });
  });

  it("filters events by Company, user, action and date", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);
    const upload = await uploadSourceFile(member.client, testWorker().jobs, {
      companyId: administrator.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!upload.ok) throw new Error(upload.error);

    const today = new Date();
    const yesterday = new Date(today.valueOf() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(today.valueOf() + 86_400_000).toISOString().slice(0, 10);
    const filtered = await listAuditEventPage(administrator.client, administrator.organizationId, {
      companyId: administrator.companyId,
      actorUserId: member.userId,
      action: "source_file.uploaded",
      from: yesterday,
      to: tomorrow,
    });

    expect(filtered.events).toEqual([
      expect.objectContaining({
        actorUserId: member.userId,
        companyId: administrator.companyId,
        action: "source_file.uploaded",
        targetId: upload.value.id,
      }),
    ]);
    expect(filtered.total).toBe(1);
    expect((await listAuditEventPage(administrator.client, administrator.organizationId, {
      from: "2099-01-01",
      to: "2099-01-31",
    })).events).toEqual([]);
  });

  it("ignores malformed date filters", async () => {
    const { client, organizationId } = await administratorWithCompany();

    expect((await listAuditEventPage(client, organizationId, { to: "2026-99-99" })).total).toBe(5);
  });

  it("lists the Organization's users for the actor filter without duplicates", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);

    expect(await listAuditActors(administrator.client, administrator.organizationId)).toEqual([
      { userId: administrator.userId, email: administrator.email },
      { userId: member.userId, email: member.email },
    ].sort((a, b) => a.email.localeCompare(b.email)));
  });

  it("keeps removed event actors available to the user filter", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);
    const uploaded = await uploadSourceFile(member.client, testWorker().jobs, {
      companyId: administrator.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const memberships = await listMemberships(administrator.client, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
    });
    const membership = memberships.find((candidate) => candidate.userId === member.userId)!;
    expect(await removeMembership(administrator.client, membership.id)).toEqual({ ok: true, value: null });

    expect(await listAuditActors(administrator.client, administrator.organizationId)).toContainEqual({
      userId: member.userId,
      email: member.email,
    });
    const filtered = await listAuditEventPage(administrator.client, administrator.organizationId, {
      actorUserId: member.userId,
    });
    expect(filtered.events).toContainEqual(expect.objectContaining({
      action: "source_file.uploaded",
      targetId: uploaded.value.id,
    }));
  });

  it("keeps a soft-deleted Company's name available to historical filters", async () => {
    const company = await administratorWithCompany("Historical Company Organization");
    const worker = testWorker();
    const exported = await exportCompanyData(company.client, worker.jobs, {
      companyId: company.companyId,
    });
    if (!exported.ok) throw new Error(exported.error);
    expect(await worker.runJobs()).toEqual([]);
    expect(await softDeleteCompany(company.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    })).toEqual({ ok: true, value: expect.any(Object) });

    expect(await listMyCompanies(company.client)).toEqual([]);
    expect(await listAuditCompanies(company.client, company.organizationId)).toContainEqual({
      id: company.companyId,
      name: "Novák s.r.o.",
    });
    expect((await listAuditEventPage(company.client, company.organizationId, {
      companyId: company.companyId,
    })).events).toContainEqual(expect.objectContaining({
      action: "company.deleted",
      companyId: company.companyId,
    }));
  });

  it("records the sign-up without the User's personal data", async () => {
    const { client, userId, organizationId } = await provisionedUser("Novák s.r.o.");

    expect(await listAuditEvents(client, organizationId)).toEqual([
      expect.objectContaining({
        action: "user.signed_up",
        actorUserId: userId,
        organizationId,
        companyId: null,
        targetType: "user",
        targetId: userId,
        payload: { organization_name: "Novák s.r.o." },
      }),
    ]);
  });

  it("keeps the email out of the sign-up event when no Organization name was given", async () => {
    // Account creation without an explicit Organization name falls back to the
    // email; the audit payload must not repeat it.
    const { client } = await provisionedAccount({ email: uniqueEmail(), password: "correct-horse-battery" });
    const [organization] = await listMyOrganizations(client);

    const [signUpEvent] = await listAuditEvents(client, organization.id);

    expect(signUpEvent).toEqual(expect.objectContaining({ action: "user.signed_up", payload: {} }));
  });

  it("records Company creation", async () => {
    const { client, userId, organizationId, companyId } = await administratorWithCompany();

    const events = await listAuditEvents(client, organizationId);

    expect(events.map((e) => e.action)).toEqual([
      "user.signed_up",
      "company.created",
      "company.setup_changed",
      "reporting_year.generated",
      "company.setup_changed",
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        actorUserId: userId,
        organizationId,
        companyId,
        targetType: "company",
        targetId: companyId,
        payload: expect.objectContaining({ name: "Novák s.r.o." }),
      }),
    );
    expect(events[2]).toEqual(expect.objectContaining({
      action: "company.setup_changed",
      payload: { state: "completed", step: "identity" },
    }));
    expect(events[4]).toEqual(expect.objectContaining({
      action: "company.setup_changed",
      payload: { state: "completed", step: "filing_frequency" },
    }));
  });

  it("records a Source File upload", async () => {
    const { client, userId, organizationId, companyId } = await administratorWithCompany();
    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!result.ok) throw new Error(result.error);

    const events = await listAuditEvents(client, organizationId);

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        action: "source_file.uploaded",
        actorUserId: userId,
        organizationId,
        companyId,
        targetType: "source_file",
        targetId: result.value.id,
        payload: {
          file_name: "two-invoices.pdf",
          format: "pdf",
          byte_size: 1303,
          sha256: "79ae60b6a1040a3eaf64d441f2fa48f627a18d1e5c1ad831ba6919e9e9c663ea",
          page_count: 2,
        },
      }),
    );
  });

  it("cannot be written, changed or deleted by users, even through direct queries", async () => {
    const { client, userId, organizationId } = await administratorWithCompany();
    const before = await listAuditEvents(client, organizationId);

    const insert = await client.from("audit_event").insert({
      organization_id: organizationId,
      actor_user_id: userId,
      action: "company.created",
      target_type: "company",
    });
    const update = await client.from("audit_event").update({ action: "tampered" }).eq("organization_id", organizationId);
    const remove = await client.from("audit_event").delete().eq("organization_id", organizationId);

    for (const attempt of [insert, update, remove]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect(await listAuditEvents(client, organizationId)).toEqual(before);
  });

  it("is not readable by another Organization", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await provisionedUser("Organization B");

    expect(await listAuditEvents(b.client, a.organizationId)).toEqual([]);
  });

  it("is not readable by a Company User in the same Organization", async () => {
    const administrator = await administratorWithCompany();
    const user = await companyMember(administrator);

    expect(await listAuditEventPage(user.client, administrator.organizationId)).toEqual({
      events: [],
      page: 1,
      pageSize: 50,
      total: 0,
      pageCount: 1,
    });
  });
});
