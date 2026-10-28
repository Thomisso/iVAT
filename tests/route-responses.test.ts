import { describe, expect, it } from "vitest";
import {
  downloadResponse,
  refusalResponse,
  successfulCommandResponse,
} from "@/lib/route-responses";

describe("private route response policy", () => {
  it("applies private download headers and optional receipt headers", async () => {
    const response = downloadResponse({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "report.xlsx",
      mediaType: "application/test",
    }, { "X-Receipt-Id": "receipt" });

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("application/test");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.xlsx"');
    expect(response.headers.get("x-receipt-id")).toBe("receipt");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("maps refusals and successful commands with the same security headers", async () => {
    const refusal = refusalResponse("forbidden");
    expect(refusal.status).toBe(404);
    expect(await refusal.json()).toEqual({ error: "forbidden" });
    expect(refusal.headers.get("cache-control")).toBe("private, no-store");
    expect(refusalResponse("invalid_reporting_period").status).toBe(422);
    expect(await refusalResponse("report_not_found", { status: 404, message: "Missing" }).json()).toEqual({
      error: "report_not_found",
      message: "Missing",
    });
    const success = successfulCommandResponse();
    expect(success.status).toBe(204);
    expect(success.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
