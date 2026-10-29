import type { Result } from "./client";

type InvitationUrls = {
  acceptUrl: string;
  callbackUrl: string;
};

type InvitationUrlConfiguration = {
  appOrigin: string | undefined;
  authRedirectAllowlist: string | undefined;
};

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function invitationUrls(
  configuration: InvitationUrlConfiguration,
): Result<InvitationUrls, "invitation_failed"> {
  const origin = configuration.appOrigin ? httpUrl(configuration.appOrigin) : null;
  if (!origin || origin.pathname !== "/" || origin.search || origin.hash) {
    return { ok: false, error: "invitation_failed" };
  }

  const callback = new URL("/auth/callback", origin.origin);
  const configuredCallbacks = configuration.authRedirectAllowlist
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configuredCallbacks?.length) return { ok: false, error: "invitation_failed" };

  const allowedCallbacks = configuredCallbacks.map(httpUrl);
  if (
    allowedCallbacks.some((url) => !url || url.search || url.hash) ||
    !allowedCallbacks.some((url) => url?.toString() === callback.toString())
  ) {
    return { ok: false, error: "invitation_failed" };
  }

  return {
    ok: true,
    value: {
      acceptUrl: new URL("/invitations/accept", origin.origin).toString(),
      callbackUrl: callback.toString(),
    },
  };
}
