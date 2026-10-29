import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  AccountActions,
  AppShell,
  ContextNavigation,
  PageContent,
  PageHeader,
  PageLayout,
} from "@/components/app-shell";

test("shared shell and page primitives expose the application landmarks", () => {
  const html = renderToStaticMarkup(
    createElement(
      AppShell,
      {
        accountActions: createElement(
          AccountActions,
          { label: "Account actions" },
          createElement("button", { type: "button" }, "Account"),
        ),
        brandHref: "/",
        brandLabel: "iVAT",
        context: createElement("button", { type: "button" }, "Example Company"),
        navigation: createElement(ContextNavigation, {
          items: [
            { current: true, href: "/companies/example", label: "Overview" },
            { href: "/companies/example/documents", label: "Documents" },
          ],
          label: "Company navigation",
        }),
        skipLabel: "Skip to content",
      },
      createElement(
        PageLayout,
        { measure: "wide" },
        createElement(PageHeader, {
          actions: createElement("button", { type: "button" }, "Add Source Files"),
          description: "Documents that need attention.",
          title: "Documents",
        }),
        createElement(
          PageContent,
          { measure: "narrow" },
          createElement("form", { "aria-label": "Document filters" }),
        ),
      ),
    ),
  );

  expect(html).toContain('href="#main-content"');
  expect(html).toContain('aria-label="iVAT"');
  expect(html).toContain('aria-label="Company navigation"');
  expect(html).toMatch(/aria-current="page"[^>]*>\s*<span>Overview<\/span>/);
  expect(html).toContain('aria-label="Account actions"');
  expect(html).toContain("<main");
  expect(html).toContain("<h1>Documents</h1>");
  expect(html).toContain("Add Source Files");
  expect(html).toContain('aria-label="Document filters"');
});
