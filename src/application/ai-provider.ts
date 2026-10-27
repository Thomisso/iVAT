import type { ExtractionPayload } from "./extraction-payload";
import type { SourceFileFormat } from "./source-files";

/** Content sent to an AI provider: a whole Source File for Split, one Document's pages for Extract. */
export type AiInput = { format: SourceFileFormat; mediaType: string; bytes: Uint8Array; pageCount: number };

/** A Document found by Split, as an inclusive range of 1-based page numbers. */
export type PageRange = { firstPage: number; lastPage: number };

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
  split(input: AiInput): Promise<{ model: string; documents: PageRange[] }>;
  extract(input: AiInput): Promise<{ model: string; payload: ExtractionPayload }>;
}
