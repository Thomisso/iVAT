import type { ExtractionPayload } from "./extraction-payload";

/** An unbound provider reference on the oriented PDF input, before server source binding. */
export type SourcePageLocation = {
  fieldPath: string;
  kind: "page";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

const SCALAR_FIELDS = new Set([
  "documentType", "documentNumber", "issueDate", "taxPointDate", "dueDate", "direction", "currency",
  "proposedVatRegime", "reverseChargeCode", "originalDocumentNumber",
  ...["supplier", "customer"].flatMap((party) =>
    ["name", "ico", "vatId", "street", "city", "postalCode", "country"].map((field) => `${party}.${field}`)),
  ...["netAmount", "vatAmount", "grossAmount"].map((field) => `totals.${field}`),
  ...["variableSymbol", "bankAccount", "iban"].map((field) => `payment.${field}`),
]);
const LOCATION_KEYS = new Set(["fieldPath", "kind", "page", "x", "y", "width", "height"]);

/** Missing or invalid evidence is informational; it never invalidates financial values. */
export function validSourcePageLocations(value: unknown, payload: ExtractionPayload, pageCount: number): SourcePageLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SourcePageLocation[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !LOCATION_KEYS.has(key))) return [];
    const location = entry as SourcePageLocation;
    if (typeof location.fieldPath !== "string" || location.kind !== "page"
      || !Number.isInteger(location.page) || location.page < 1 || location.page > pageCount
      || ![location.x, location.y, location.width, location.height].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
      || location.x < 0 || location.y < 0 || location.width <= 0 || location.height <= 0
      || location.x + location.width > 1 || location.y + location.height > 1) return [];
    const rateField = /^rateBreakdown\.(0|[1-9]\d*)\.(rate|netAmount|vatAmount)$/.exec(location.fieldPath);
    if (!SCALAR_FIELDS.has(location.fieldPath)
      && !(rateField && Number(rateField[1]) < payload.rateBreakdown.length)) return [];
    return [{
      fieldPath: location.fieldPath, kind: "page", page: location.page,
      x: location.x, y: location.y, width: location.width, height: location.height,
    }];
  });
}

export type SourceFieldEvidence = {
  origin: "ai" | "manual";
  originalValue: string | number;
  locations: Omit<SourcePageLocation, "fieldPath">[];
};

/** Identity and page basis supplied by the server, scoped by the containing immutable Version. */
export type SourceEvidence = {
  schemaVersion: 1;
  sourceFileId: string;
  sourceSha256: string;
  documentId: string;
  originExtractionRequestId: string;
  basis: { kind: "original"; format: "pdf"; sha256: string };
  range: { firstPage: number; lastPage: number };
  fields: Record<string, SourceFieldEvidence>;
};

export function sourceFieldValue(payload: ExtractionPayload, field: string): string | number | null {
  const value = field.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null, payload);
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** Never carries a provider-selected identity or a prior AI Version's reference forward. */
export function bindPdfSourceEvidence(payload: ExtractionPayload, source: {
  sourceFileId: string; sha256: string; documentId: string; requestId: string;
  format: string; firstPage: number; lastPage: number;
}): ExtractionPayload {
  const clean = { ...payload };
  delete clean.sourceLocations;
  delete clean.sourceEvidence;
  if (source.format !== "pdf") return clean;
  const fields: Record<string, SourceFieldEvidence> = {};
  for (const location of validSourcePageLocations(payload.sourceLocations, payload, source.lastPage - source.firstPage + 1)) {
    // Direction is inferred against the Company's identity, rather than read from this box.
    if (location.fieldPath === "direction") continue;
    const originalValue = sourceFieldValue(payload, location.fieldPath);
    if (originalValue === null) continue;
    const field = fields[location.fieldPath] ??= { origin: "ai", originalValue, locations: [] };
    field.locations.push({
      kind: "page", page: source.firstPage + location.page - 1,
      x: location.x, y: location.y, width: location.width, height: location.height,
    });
  }
  if (!Object.keys(fields).length) return clean;
  return { ...clean, sourceEvidence: {
    schemaVersion: 1, sourceFileId: source.sourceFileId, sourceSha256: source.sha256,
    documentId: source.documentId, originExtractionRequestId: source.requestId,
    basis: { kind: "original", format: "pdf", sha256: source.sha256 },
    range: { firstPage: source.firstPage, lastPage: source.lastPage }, fields,
  } };
}

export function remapSourceField(field: string, indices: Map<number, number>): string | null {
  const path = /^rateBreakdown\.(\d+)\.(.+)$/.exec(field);
  if (!path) return field;
  const index = indices.get(Number(path[1]));
  return index === undefined ? null : `rateBreakdown.${index}.${path[2]}`;
}
