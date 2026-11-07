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
