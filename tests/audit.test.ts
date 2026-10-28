import { describe, expect, it } from "vitest";
import { listAuditActors, listAuditEventPage, listAuditEvents } from "@/application/audit";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import { anonymousClient, signedUpUser, uniqueEmail } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { administratorWithCompany, companyMember } from "./support/fixtures";

describe("audit log", () => {
  it("paginates an Organization's events newest first", async () => {
    const { client, organizationId } = await administratorWithCompany();

    const first = await listAuditEventPage(client, organizationId, { page: 1, pageSize: 2 });
    const second = await listAuditEventPage(client, organizationId, { page: 2, pageSize: 2 });

    expect(first).toEqual({
      events: [
        expect.objectContaining({ action: "company.filing_frequency_changed" }),
        expect.objectContaining({ action: "company.created" }),
      ],
      page: 1,
      pageSize: 2,
      total: 3,
      pageCount: 2,
    });
    expect(second).toEqual({
      events: [expect.objectContaining({ action: "user.signed_up" })],
      page: 2,
      pageSize: 2,
      total: 3,
      pageCount: 2,
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

    expect((await listAuditEventPage(client, organizationId, { to: "2026-99-99" })).total).toBe(3);
  });

  it("lists the Organization's users for the actor filter without duplicates", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);

    expect(await listAuditActors(administrator.client, administrator.organizationId)).toEqual([
      { userId: administrator.userId, email: administrator.email },
      { userId: member.userId, email: member.email },
    ].sort((a, b) => a.email.localeCompare(b.email)));
  });

  it("records the sign-up without the User's personal data", async () => {
    const { client, userId, organizationId } = await signedUpUser("Novák s.r.o.");

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
    // Sign-up paths without an Organization name (such as a social login) name the
    // Organization after the email; the audit payload must not repeat it.
    const client = anonymousClient();
    await client.auth.signUp({ email: uniqueEmail(), password: "correct-horse-battery" });
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
      "company.filing_frequency_changed",
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
    const b = await signedUpUser("Organization B");

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
