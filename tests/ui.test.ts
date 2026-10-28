import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Money } from "@/components/money";
import { statusBadgeState } from "@/components/status-badge-state";
import { mfaRedirectPath } from "@/application/mfa-routing";
import { acceptsFile } from "@/components/drop-zone";

test("Money shows Czech amounts and a true minus for Credit Notes", () => {
  const positive = renderToStaticMarkup(
    createElement(Money, { amount: 24200 }),
  );
  expect(positive).toContain("24 200,00");
  expect(positive).toContain("Kč");
  const negative = renderToStaticMarkup(
    createElement(Money, { amount: -2420, currency: "" }),
  );
  expect(negative).toContain("−2 420,00");
  expect(negative).toContain("is-negative");
  expect(negative).not.toContain("Kč");
});

test("DropZone accepts case-insensitive extensions and MIME filters, rejecting other formats", () => {
  expect(
    acceptsFile({ name: "invoice.PDF", type: "" }, ".pdf,.png,.jpg,.jpeg"),
  ).toBe(true);
  expect(
    acceptsFile({ name: "receipt.jpg", type: "image/jpeg" }, "image/*"),
  ).toBe(true);
  expect(
    acceptsFile(
      { name: "invoice", type: "application/pdf" },
      "application/pdf",
    ),
  ).toBe(true);
  expect(
    acceptsFile(
      { name: "invoice.exe", type: "application/octet-stream" },
      ".pdf,.png,.jpg,.jpeg",
    ),
  ).toBe(false);
  expect(acceptsFile({ name: "receipt.png.exe", type: "" }, ".png")).toBe(
    false,
  );
});

test("badge mapping distinguishes Source File Split from Document Extraction and rejection from failure", () => {
  expect(statusBadgeState("processing", "source-file")).toBe("splitting");
  expect(statusBadgeState("processing", "document")).toBe("extracting");
  expect(statusBadgeState("needs_review", "document")).toBe("needs-review");
  expect(statusBadgeState("split", "source-file")).toBe("split");
  expect(statusBadgeState("rejected", "document")).toBe("rejected");
  expect(statusBadgeState("approved", "document")).toBe("approved");
});

test("MFA routing forces enrollment or verification before application access", () => {
  expect(
    mfaRedirectPath("/companies/new", {
      required: true,
      enrolled: false,
      satisfied: false,
    }),
  ).toBe("/mfa/enroll");
  expect(
    mfaRedirectPath("/companies/new", {
      required: false,
      enrolled: true,
      satisfied: false,
    }),
  ).toBe("/mfa/verify");
  expect(
    mfaRedirectPath("/mfa/verify", {
      required: true,
      enrolled: true,
      satisfied: false,
    }),
  ).toBeNull();
  expect(
    mfaRedirectPath("/mfa/enroll", {
      required: true,
      enrolled: true,
      satisfied: true,
    }),
  ).toBe("/");
  expect(
    mfaRedirectPath("/companies/new", {
      required: false,
      enrolled: false,
      satisfied: true,
    }),
  ).toBeNull();
  expect(
    mfaRedirectPath("/mfa/enroll", {
      required: false,
      enrolled: false,
      satisfied: true,
    }),
  ).toBeNull();
});
