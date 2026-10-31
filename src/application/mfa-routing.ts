export type MfaPolicy = {
  required: boolean;
  enrolled: boolean;
  satisfied: boolean;
};

/** The MFA route a signed-in request must visit before application data. */
export function mfaRedirectPath(
  pathname: string,
  policy: MfaPolicy,
): string | null {
  // Recovery performs its own native TOTP challenge before credential updates.
  if (pathname === "/password/forgot" || pathname === "/password/reset") return null;
  const onEnrollment = pathname === "/mfa/enroll";
  const onVerification = pathname === "/mfa/verify";

  if (policy.required && !policy.enrolled) {
    return onEnrollment ? null : "/mfa/enroll";
  }
  if (policy.enrolled && !policy.satisfied) {
    return onVerification ? null : "/mfa/verify";
  }
  if (onVerification && policy.satisfied) return "/";
  return null;
}
