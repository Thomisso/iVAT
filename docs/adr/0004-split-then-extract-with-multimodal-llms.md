# Split → Extract pipeline on multimodal LLMs, no separate OCR

A Source File can contain several Documents (for example a PDF with five invoices, or an Excel sheet listing invoices). Processing therefore runs in two steps:

1. **Split** returns the Documents as page ranges (or row sets for spreadsheets). Users can correct the Split in review.
2. **Extract** then runs on each Document separately.

Split sends PDFs natively to multimodal LLMs (Anthropic and OpenAI at MVP) behind a provider abstraction, with the model configurable per step. For Extraction, the worker rasterizes the Document's visible, oriented PDF pages before sending them as numbered images in one request. Original Source Files remain unchanged and supply the review preview. This avoids the systematic coordinate displacement reproduced with native text/vector PDF Extraction in #253; it does not make model locations verified facts. Standalone images retain their existing input path. The MVP has no dedicated OCR engine. Extractor is an interface, so an OCR+LLM strategy can be added if quality or cost on scans requires it.

## Considered Options

- One Source File = one Document. Rejected: multi-invoice PDFs are common in practice.
- OCR (Tesseract or Azure Document Intelligence) followed by text-only LLM. Deferred: modern multimodal models read PDFs and images natively, and an extra engine adds cost and failure modes.

## Explicit Photo Groups

A User may confirm JPEG/PNG photographs as one ordered Photo Group before the Upload Batch starts. Its unchanged originals remain individual Source Files. The frozen selection records the group identity and order, human author and time. The group creates exactly one Document, anchored to its first Source File for compatible history and batch queries. AI Split is bypassed and existing page correction cannot change these human boundaries. Ungrouped files retain Split → Extract.

The worker decodes and orients each photograph into a stored PNG page, then embeds those exact PNGs in an ordered PDF for review. The stored PNGs are supplied to both production provider adapters in a single Extraction request; they are not regenerated or rasterized again. The immutable group basis manifest binds original identities/hashes, processed page hashes and PDF hash. Source Evidence names that group and basis, with page coordinates in that processed representation. Review links each original separately; archives retain originals, the decision/manifest, PDF and processed PNGs. Failures remain failures rather than replacing originals or inventing an Extraction.

This extends ADR-0015's single-source relationship without making a Source File a multi-file object. It preserves the immutable Versions of ADR-0005, database authority of ADR-0008, locks of ADR-0007 and one successful Extraction allowance under ADR-0011. HEIC/HEIF groups and group recovery are separate slices.
