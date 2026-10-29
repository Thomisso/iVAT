import { describe, expect, it } from "vitest";
import {
  documentQueueFilters,
  documentQueueQuery,
  normalizeDocumentQueueQuery,
  parseDocumentQueue,
} from "@/application/document-queue";

describe("Documents queue context", () => {
  it.each([
    [undefined, "review", "needs_review", undefined],
    ["failed", "failed", "failed", undefined],
    ["approved", "approved", "approved", undefined],
    ["incoming", "incoming", undefined, "incoming"],
    ["outgoing", "outgoing", undefined, "outgoing"],
    ["all", "all", undefined, undefined],
  ] as const)("maps saved view %s to its fixed filter", (requested, view, status, direction) => {
    const queue = parseDocumentQueue({ view: requested });
    expect(queue).toMatchObject({ view, status, direction });
  });

  it("removes redundant Direction and Status filters from fixed saved views", () => {
    expect(documentQueueQuery(parseDocumentQueue({
      view: "incoming",
      direction: "outgoing",
      status: "rejected",
    }))).toBe("view=incoming&status=rejected");
    expect(documentQueueQuery(parseDocumentQueue({
      view: "review",
      status: "approved",
      direction: "incoming",
    }))).toBe("view=review&direction=incoming");
  });

  it("keeps all user filters in a stable URL and Application filter object", () => {
    const queue = parseDocumentQueue({
      view: "all",
      status: "rejected",
      direction: "outgoing",
      reportingPeriod: " 2026-10 ",
      counterparty: "  Acme & syn  ",
      hasFindings: "1",
      batchId: "batch-id",
      readiness: "warnings",
    });
    expect(documentQueueQuery(queue)).toBe(
      "view=all&status=rejected&direction=outgoing&reportingPeriod=2026-10&counterparty=Acme+%26+syn&hasFindings=1&batchId=batch-id&readiness=warnings",
    );
    expect(documentQueueFilters(queue, ["source-id"])).toEqual({
      status: "rejected",
      direction: "outgoing",
      reportingPeriod: undefined,
      counterparty: "Acme & syn",
      hasFindings: true,
      sourceFileIds: ["source-id"],
    });
  });

  it("requires a Reporting Period for a readiness filter and makes rejected explicit", () => {
    expect(parseDocumentQueue({ view: "all", readiness: "blockers" }).readiness).toBeUndefined();
    expect(parseDocumentQueue({
      view: "all",
      readiness: "rejected",
      reportingPeriod: "2026-Q4",
    })).toMatchObject({
      readiness: "rejected",
      reportingPeriod: "2026-Q4",
      status: "rejected",
    });
  });

  it("drops unknown parameters when normalizing action redirects", () => {
    expect(normalizeDocumentQueueQuery("view=failed&next=https%3A%2F%2Fevil.test&hasFindings=1"))
      .toBe("view=failed&hasFindings=1");
  });
});
