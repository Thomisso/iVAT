import { expect, it } from "vitest";
import { provisionedUser } from "../tests/support/clients";
import { baseUrl, httpAs } from "./support/http";

it("keeps private real-Auth transport, independent liveness and fail-closed session behavior through dependency faults", async () => {
  const control = process.env.IVAT_HTTP_TRANSPORT_CONTROL_URL;
  if (!control || new URL(control).hostname !== "127.0.0.1") throw new Error("Runner-owned local HTTP transport required");
  const user = await provisionedUser("HTTP transport");
  const request = await httpAs(user.client);
  const state = async (input: object) => {
    const response = await fetch(`${control}/state`, { method: "POST", body: JSON.stringify(input) });
    expect(response.status).toBe(204);
  };
  try {
    await state({ clearPaths: true });
    const success = await request("/settings/security");
    expect(success.status).toBe(200);
    expect(await success.text()).toContain("Security");
    const paths: string[] = await (await fetch(`${control}/paths`)).json();
    expect(paths.some(path => path.startsWith("/auth/v1/user"))).toBe(true);
    expect(paths.some(path => path.includes("current_mfa_policy"))).toBe(true);
    for (const fault of [{ unavailable: true }, { stall: true }]) {
      await state(fault);
      const started = Date.now();
      const auth = await request("/health/auth");
      expect(auth.status).toBe(503);
      expect(await auth.json()).toEqual({ status: "degraded" });
      expect(auth.headers.get("cache-control")).toBe("no-store");
      expect(auth.headers.get("set-cookie")).toBeNull();
      expect(Date.now() - started).toBeLessThan(6_000);
      if ("unavailable" in fault) {
        const protectedPage = await request("/settings/security");
        expect(protectedPage.status).toBe(503);
        expect(protectedPage.headers.get("retry-after")).toBe("30");
        expect(protectedPage.headers.get("set-cookie")).toBeNull();
        const text = await protectedPage.text();
        expect(text).toContain("Session verification is temporarily unavailable");
        expect(text).not.toContain("<h1");
      }
      const live = await fetch(`${baseUrl()}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });
      await state({});
      expect((await request("/settings/security")).status).toBe(200);
    }
  } finally { await state({}); }
});
