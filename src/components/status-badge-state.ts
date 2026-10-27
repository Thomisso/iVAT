import type { DocumentStatus as ApplicationDocumentStatus } from "@/application/documents";
import type { SourceFileStatus } from "@/application/source-files";
import type { DocumentStatus } from "./status-badge";

/** Keep the database lifecycle at the boundary; processing means different work for each object. */
export function statusBadgeState(
  status: ApplicationDocumentStatus | SourceFileStatus,
  target: "document" | "source-file",
): DocumentStatus {
  if (status === "processing")
    return target === "source-file" ? "splitting" : "extracting";
  if (status === "needs_review") return "needs-review";
  return status;
}
