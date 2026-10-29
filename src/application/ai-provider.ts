import type { ExtractionPayload } from "./extraction-payload";
import type { SourceFileFormat } from "./source-files";
import type { WorkbookRowSet } from "./workbooks";

/** Content sent to an AI provider: a whole Source File for Split, one Document's pages for Extract. */
export type AiInput = {
  format: SourceFileFormat;
  mediaType: string;
  bytes: Uint8Array;
  pageCount: number;
  /** Present when `bytes` is the row-numbered textual representation of a workbook. */
  text?: string;
  /** Populated worksheet bounds, for validating a spreadsheet Split. */
  workbookRowSets?: WorkbookRowSet[];
};

/** A Document found by Split, as an inclusive range of 1-based page numbers. */
export type PageRange = { firstPage: number; lastPage: number };
/** A Document found in a workbook, as an inclusive 1-based row set on one sheet. */
export type RowRange = WorkbookRowSet;
export type SourceRange = PageRange | RowRange;

export type AiProviderConfiguration = { apiKey: string; splitModel: string; extractModel: string };

export type AiCallContext = {
  organizationId: string;
  /** Resolved inside the worker handler; browser/application callers never receive it. */
  configuration: AiProviderConfiguration;
};

/** Token counts returned by a provider for one completed request. */
export type AiUsage = { inputTokens: number; outputTokens: number };

export const AI_PROCESSING_ISSUE_CLASSIFICATIONS = [
  "configuration_missing",
  "configuration_unusable",
  "invalid_credentials",
  "provider_credits_exhausted",
  "provider_unavailable",
  "provider_response_invalid",
  "processing_failed",
] as const;
export type AiProcessingIssueClassification = (typeof AI_PROCESSING_ISSUE_CLASSIFICATIONS)[number];

/** A provider/configuration refusal whose retryability is known. */
export class AiProviderError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly classification: AiProcessingIssueClassification;
  readonly platformIntervention: boolean;
  readonly configurationId: string | null;
  readonly provider: string | null;

  constructor(code: string, message: string, options: {
    transient: boolean;
    classification?: AiProcessingIssueClassification;
    platformIntervention?: boolean;
    configurationId?: string;
    provider?: string;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.code = code;
    this.transient = options.transient;
    this.classification = options.classification ?? (options.transient
      ? "provider_unavailable"
      : "provider_response_invalid");
    this.platformIntervention = options.platformIntervention ?? false;
    this.configurationId = options.configurationId ?? null;
    this.provider = options.provider ?? null;
  }
}

/**
 * An AI provider adapter (ADR-0004). Implementations send PDFs and images
 * natively and throw on technical failures; the job retries and finally marks
 * the Source File or Document Failed.
 */
export interface AiProvider {
  /** Recorded on every Extraction Version. */
  readonly name: string;
  /** Where the provider processes the Documents it receives. */
  readonly region: string;
  split(input: AiInput, context?: AiCallContext): Promise<{ model: string; documents: SourceRange[]; usage?: AiUsage }>;
  extract(input: AiInput, context?: AiCallContext): Promise<{ model: string; payload: ExtractionPayload; usage?: AiUsage }>;
}
