import {
  createElement,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { VisualPrototype } from "@/components/visual-prototype";
import { shouldSkipDatabaseSetup } from "./support/global-setup";
import czechMessages from "../messages/cs.json";
import messages from "../messages/en.json";

type TestProviderProps = Omit<
  ComponentProps<typeof NextIntlClientProvider>,
  "children"
> & { children?: ReactNode };

const TestProvider = NextIntlClientProvider as ComponentType<TestProviderProps>;

function render(screen: Parameters<typeof VisualPrototype>[0]["screen"]) {
  return renderToStaticMarkup(
    createElement(
      TestProvider,
      {
        locale: "en",
        messages,
        timeZone: "Europe/Prague",
      },
      createElement(VisualPrototype, { screen }),
    ),
  );
}

function renderCzech(screen: Parameters<typeof VisualPrototype>[0]["screen"]) {
  return renderToStaticMarkup(
    createElement(
      TestProvider,
      {
        locale: "cs",
        messages: czechMessages,
        timeZone: "Europe/Prague",
      },
      createElement(VisualPrototype, { screen }),
    ),
  );
}

test("the prototype exposes the agreed Company navigation with an explicit current destination", () => {
  const html = render("overview");

  expect(html).toContain("Company navigation");
  expect(html).toContain("Overview");
  expect(html).toContain("Upload");
  expect(html).toContain("Documents");
  expect(html).toContain("VAT");
  expect(html).toContain("Settings");
  expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Overview/);
});

test("the representative screens show truthful work states without invented AI evidence", () => {
  const upload = render("upload");
  expect(upload).toContain("Take document photo");
  expect(upload).toContain('role="status"');
  expect(upload).toContain("Extraction in progress");
  expect(upload).toContain("Retry extraction");
  expect(upload).not.toMatch(/confidence|\d+\s?%|field highlight/i);

  const documents = render("documents");
  expect(documents).toContain("Needs review");
  expect(documents).toContain("3 of 12");

  const review = render("review");
  expect(review).toContain("Approve document");
  expect(review).toContain("Previous document");
  expect(review).toContain("Next document");

  const vat = render("vat");
  expect(vat).toContain("Reporting periods");
  expect(vat).toContain("2 blockers");

  const output = render("vat-output");
  expect(output).toContain("VAT Return");
  expect(output).toContain("Draft XML");
  expect(output).toContain("DRAFT_DPHDP3_2026-09.xml");
  expect(output).toContain('href="/prototype?screen=vat-statement"');
  expect(output).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?Finalize and create final XML/);

  const statement = render("vat-statement");
  expect(statement).toContain("Control Statement · September 2026");
  expect(statement).toContain("DRAFT_DPHKH1_2026-09.xml");
});

test("English screens preserve Czech statutory date and money formatting", () => {
  const documents = render("documents");
  expect(documents).toContain("14. 10. 2026");
  expect(documents).toContain("24 200,00 Kč");
  expect(documents).not.toMatch(/14 Oct 2026|24,200\.00 CZK/);

  const review = render("review");
  expect(review).toContain("14. 10. 2026");
  expect(review).toContain("TOTAL 24 200,00 Kč");

  const output = render("vat-output");
  expect(output).toContain("122 640,00 Kč");
  expect(output).not.toMatch(/122,640\.00 CZK/);
});

test("Source File actions do not call files Documents or Uploads", () => {
  expect(messages.prototype.overview.upload).toBe("Add Source Files");
  expect(messages.prototype.overview.empty.detail).toBe("New Source Files will appear here.");
  expect(czechMessages.prototype.overview.upload).toBe("Přidat zdrojové soubory");
  expect(czechMessages.prototype.overview.empty.detail).toBe("Nové zdrojové soubory se zobrazí zde.");
});

test("Czech workspace copy uses canonical tax terms outside the Source File preview", () => {
  expect(renderCzech("documents")).toContain("Datum uskutečnění zdanitelného plnění");

  const review = renderCzech("review");
  const workspace = review.replace(/<section[^>]*aria-label="Náhled zdrojového souboru"[\s\S]*?<\/section>/, "");
  expect(workspace).toContain("Daňové identifikační číslo");
  expect(workspace).toContain("Datum uskutečnění zdanitelného plnění");
  expect(workspace).not.toMatch(/\b(?:DUZP|DIČ)\b/);
  expect(review).toContain("DUZP");

  const settings = renderCzech("settings");
  expect(settings).toContain("daňové identifikační číslo");
  expect(settings).not.toMatch(/\b(?:DUZP|DIČ)\b/);
});

test("database setup is skipped only for an exact allowlisted Vitest scope", () => {
  const vitest = ["node", "vitest", "run"];
  expect(shouldSkipDatabaseSetup([...vitest, "tests/visual-prototype.test.ts"])).toBe(true);
  expect(shouldSkipDatabaseSetup([...vitest, "tests", "tests/visual-prototype.test.ts"])).toBe(false);
  expect(shouldSkipDatabaseSetup([...vitest, "tests/visual-prototype.test.ts", "tests/period-lock.test.ts"])).toBe(false);
  expect(shouldSkipDatabaseSetup(vitest)).toBe(false);
});
