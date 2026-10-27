import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import { anonymousClient, signedUpUser, uniqueEmail } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { administratorWithCompany } from "./support/fixtures";

describe("audit log", () => {
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
});
