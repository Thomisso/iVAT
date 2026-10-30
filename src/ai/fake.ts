import type { AiInput, AiProvider, SourceRange } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";

export type FakeAiScript = {
  split?: (input: AiInput) => SourceRange[] | Promise<SourceRange[]>;
  extract?: (input: AiInput) => ExtractionPayload | Promise<ExtractionPayload>;
};

/**
 * A domestic invoice at 21 %, the fake's default Extraction. It is incoming for
 * a Company whose identity is its customer's.
 */
export const SAMPLE_EXTRACTION: ExtractionPayload = {
  schemaVersion: 1,
  documentType: "invoice",
  documentNumber: "FV-2026-0001",
  issueDate: "2026-10-01",
  taxPointDate: "2026-10-01",
  dueDate: "2026-10-15",
  direction: "incoming",
  supplier: {
    name: "Dodavatel s.r.o.",
    ico: "27082440",
    vatId: "CZ27082440",
    street: "Na Příkopě 1",
    city: "Praha",
    postalCode: "110 00",
    country: "CZ",
  },
  customer: {
    name: "Novák s.r.o.",
    ico: "25596641",
    vatId: "CZ25596641",
    street: "Vinohradská 12",
    city: "Praha",
    postalCode: "120 00",
    country: "CZ",
  },
  currency: "CZK",
  rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
  totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" },
  payment: { variableSymbol: "20260001", bankAccount: "123456789/0100", iban: null },
  proposedVatRegime: "domestic",
  reverseChargeCode: null,
  originalDocumentNumber: null,
  confidence: { documentNumber: 0.98, "rateBreakdown.0.vatAmount": 0.95 },
};

/**
 * An AI provider that answers from a script instead of a model, for local
 * development and tests. Unless scripted otherwise, Split finds one Document
 * per page and Extract returns {@link SAMPLE_EXTRACTION}.
 */
export function fakeAiProvider(script: FakeAiScript = {}): AiProvider {
  return {
    name: "fake",
    region: "local",
    async split(input) {
      const documents = script.split
        ? await script.split(input)
        : input.workbookRowSets
          ? input.workbookRowSets
          : Array.from({ length: input.pageCount }, (_, i) => ({ firstPage: i + 1, lastPage: i + 1 }));
      return { model: "fake-split", documents };
    },
    async extract(input) {
      return { model: "fake-extract", payload: script.extract ? await script.extract(input) : SAMPLE_EXTRACTION };
    },
  };
}
