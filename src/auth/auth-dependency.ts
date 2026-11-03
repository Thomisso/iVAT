/** Email-independent reachability only; never verifies a User or creates a session. */
export async function authDependencyAvailable(configuration: {
  url: string; publishableKey: string; fetch?: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await (configuration.fetch ?? fetch)(`${configuration.url.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: configuration.publishableKey }, signal: AbortSignal.timeout(3_000),
      cache: "no-store", redirect: "manual",
    });
    // Only status is needed. Never read or expose provider settings.
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}
