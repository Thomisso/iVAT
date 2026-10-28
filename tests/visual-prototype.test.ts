import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { VisualPrototype } from "@/components/visual-prototype";
import messages from "../messages/en.json";

function render(screen: Parameters<typeof VisualPrototype>[0]["screen"]) {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale: "en",
        messages,
        timeZone: "Europe/Prague",
        children: createElement(VisualPrototype, { screen }),
      },
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
});
