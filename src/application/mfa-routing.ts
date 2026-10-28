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
  const onEnrollment = pathname === "/mfa/enroll";
  const onVerification = pathname === "/mfa/verify";

  if (policy.required && !policy.enrolled) {
    return onEnrollment ? null : "/mfa/enroll";
  }
  if (policy.enrolled && !policy.satisfied) {
    return onVerification ? null : "/mfa/verify";
  }
  if (onEnrollment && policy.enrolled) return "/";
  if (onVerification && policy.satisfied) return "/";
  return null;
}
