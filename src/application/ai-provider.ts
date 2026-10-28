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

export const AI_CREDENTIAL_SOURCES = ["platform", "organization", "local"] as const;
export type AiCredentialSource = (typeof AI_CREDENTIAL_SOURCES)[number];
export type AiProviderConfiguration = { apiKey: string; splitModel: string; extractModel: string };

export type AiCallContext = {
  organizationId: string;
  /** The credential boundary explicitly selected by the Company Administrator. */
  credentialSource: AiCredentialSource;
  /** Resolved inside the worker handler; browser/application callers never receive it. */
  configuration?: AiProviderConfiguration;
};

/** Token counts returned by a provider for one completed request. */
export type AiUsage = { inputTokens: number; outputTokens: number };

/** A provider/configuration refusal whose retryability is known. */
export class AiProviderError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, message: string, options: { transient: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.code = code;
    this.transient = options.transient;
  }
}

/**
 * An AI provider adapter (ADR-0004). Implementations send PDFs and images
 * natively and throw on technical failures; the job retries and finally marks
 * the Source File or Document Failed.
 */
export interface AiProvider {
  /** Recorded with the Company's consent and on every Extraction Version. */
  readonly name: string;
  /** Where the provider processes the Documents it receives, as consented to by the Company. */
  readonly region: string;
  split(input: AiInput, context?: AiCallContext): Promise<{ model: string; documents: SourceRange[]; usage?: AiUsage }>;
  extract(input: AiInput, context?: AiCallContext): Promise<{ model: string; payload: ExtractionPayload; usage?: AiUsage }>;
}
