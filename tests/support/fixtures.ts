import {
  createCompany,
  type CompanySettingsInput,
} from "@/application/companies";
import { signedUpUser } from "./clients";
import { systemClient } from "./worker";

let icoCounter = 0;

/** A random but well-formed set of Company details. */
export function companyDetails(
  overrides: Partial<CompanySettingsInput> = {},
): CompanySettingsInput {
  const ico = String(
    10_000_000 + ((Date.now() + icoCounter++) % 89_999_999),
  ).slice(0, 8);
  return {
    name: "Novák s.r.o.",
    firstName: "",
    lastName: "",
    ico,
    vatId: `CZ${ico}`,
    streetName: "Vinohradská",
    houseNumber: "12",
    orientationNumber: "",
    city: "Praha",
    postalCode: "120 00",
    personType: "legal",
    filingFrequency: "monthly",
    filingFrequencyEffectiveFrom: "2026-01-01",
    ...overrides,
  };
}

/** A signed-up Organization Administrator whose Organization holds one Company. */
export async function administratorWithCompany(
  organizationName = "Test Organization",
) {
  const user = await signedUpUser(organizationName);
  const result = await createCompany(user.client, {
    organizationId: user.organizationId,
    ...companyDetails(),
  });
  if (!result.ok) throw new Error(`Company creation failed: ${result.error}`);
  return { ...user, companyId: result.value.id };
}

/**
 * A signed-up user who is a member of the Company with the given Role. Until
 * invitations exist (#23), the Membership is recorded directly with the secret key.
 */
export async function companyMember(
  { organizationId, companyId }: { organizationId: string; companyId: string },
  role: "administrator" | "user" = "user",
) {
  const user = await signedUpUser("Member's own Organization");
  const { error } = await systemClient()
    .from("membership")
    .insert({
      user_id: user.userId,
      organization_id: organizationId,
      company_id: companyId,
      email: user.email,
      role,
    });
  if (error) throw error;
  return user;
}

/** Large report fixture. Uses platform-sized Source Files and the worker's narrow
 * write functions to avoid 1001 full PDF extraction jobs; application tests still
 * generate/read as a User. */
export async function companyWithManyReportDocuments(count: number) {
  const { PDFDocument } = await import("pdf-lib");
  const { uploadSourceFile } = await import("@/application/source-files");
  const { SAMPLE_EXTRACTION } = await import("@/ai/fake");
  const admin = await administratorWithCompany();
  const system = systemClient();
  for (let first = 0; first < count; first += 50) {
    const pageCount = Math.min(50, count - first);
    const pdf = await PDFDocument.create();
    for (let page = 0; page < pageCount; page++) pdf.addPage();
    const file = await uploadSourceFile(
      admin.client,
      { async send() {} },
      {
        companyId: admin.companyId,
        fileName: `many-${first / 50 + 1}.pdf`,
        bytes: await pdf.save(),
      },
    );
    if (!file.ok) throw new Error(file.error);
    const split = await system.rpc("record_split", {
      target_source_file_id: file.value.id,
      source_ranges: Array.from({ length: pageCount }, (_, i) => ({
        firstPage: i + 1,
        lastPage: i + 1,
      })),
    });
    if (split.error) throw split.error;
  }
  for (let offset = 0; offset < count; offset += 100) {
    const { data, error } = await system
      .from("document")
      .select("id, extraction_request_id")
      .eq("company_id", admin.companyId)
      .order("id")
      .range(offset, offset + 99);
    if (error) throw error;
    await Promise.all(
      data.map(async (d) => {
        const result = await system.rpc("record_ai_extraction", {
          target_document_id: d.id,
          target_extraction_request_id: d.extraction_request_id,
          provider: "fake",
          model: "fake-extract",
          payload: SAMPLE_EXTRACTION,
          findings: [],
        });
        if (result.error) throw result.error;
      }),
    );
  }
  return admin;
}
