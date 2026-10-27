# Split → Extract pipeline on multimodal LLMs, no separate OCR

A Source File can contain several Documents (for example a PDF with five invoices, or an Excel sheet listing invoices). Processing therefore runs in two steps:

1. **Split** returns the Documents as page ranges (or row sets for spreadsheets). Users can correct the Split in review.
2. **Extract** then runs on each Document separately.

PDFs and images go straight to multimodal LLMs (Anthropic and OpenAI at MVP) behind a provider abstraction, with the model configurable per step. The MVP has no dedicated OCR engine. Extractor is an interface, so an OCR+LLM strategy can be added if quality or cost on scans requires it.

## Considered Options

- One Source File = one Document. Rejected: multi-invoice PDFs are common in practice.
- OCR (Tesseract or Azure Document Intelligence) followed by text-only LLM. Deferred: modern multimodal models read PDFs and images natively, and an extra engine adds cost and failure modes.
