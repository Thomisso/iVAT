import type { ExtractionPayload } from "./extraction-payload";

/**
 * A comparison identity only: never replaces the printed/extracted value.
 * Domestic syntax is supported without claiming that the bank account exists.
 */
export function normalizedPaymentAccount(value: string): string | null {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  const domestic = /^(?:(\d+)-)?(\d+)\/(\d{4})$/.exec(compact);
  if (domestic) {
    const digits = (part: string) => part.replace(/^0+(?=\d)/, "");
    const prefix = digits(domestic[1] ?? "0");
    const number = digits(domestic[2]);
    if (prefix.length > 6 || number.length > 10 || number === "0") return null;
    return `${prefix === "0" ? "" : `${prefix}-`}${number}/${domestic[3]}`;
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return null;
  // IBAN ISO 7064 mod-97, keeping intermediates small and exact.
  let remainder = 0;
  for (const character of compact.slice(4) + compact.slice(0, 4)) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) return null;
  if (!compact.startsWith("CZ")) return compact;
  if (!/^CZ\d{22}$/.test(compact)) return null;
  return normalizedPaymentAccount(`${compact.slice(8, 14)}-${compact.slice(14)}/${compact.slice(4, 8)}`);
}

export type PaymentAccountIdentity =
  | { outcome: "missing" }
  | { outcome: "recognized"; account: string; field: string }
  | { outcome: "inconsistent" | "unrecognized"; field: string };

/** Resolves both supplied representations without silently preferring one. */
export function paymentAccountIdentity(payment: ExtractionPayload["payment"]): PaymentAccountIdentity {
  const supplied = [
    { value: payment.bankAccount, field: "payment.bankAccount" },
    { value: payment.iban, field: "payment.iban" },
  ].filter((item) => item.value?.trim());
  if (supplied.length === 0) return { outcome: "missing" };
  const accounts = supplied.map((item) => normalizedPaymentAccount(item.value!));
  if (accounts.some((account) => account === null)) {
    return { outcome: "unrecognized", field: supplied[accounts.indexOf(null)].field };
  }
  if (new Set(accounts).size > 1) return { outcome: "inconsistent", field: "payment.bankAccount" };
  return { outcome: "recognized", account: accounts[0]!, field: supplied.at(-1)!.field };
}

