export interface MoneyProps {
  amount: number | string;
  currency?: string;
  locale?: string;
  className?: string;
}

/** Stored amounts retain their exact cents, including beyond Number's range. */
export function formatAmount(amount: number | string, locale = "cs-CZ") {
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (typeof amount === "string") {
    const decimal = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
    if (!decimal) throw new Error("Money requires a stored amount with two decimal places");
    return (decimal[1] ? "−" : "") + formatter.formatToParts(BigInt(decimal[2]))
      .map(part => part.type === "fraction" ? decimal[3] : part.value).join("");
  }
  return (
    (amount < 0 ? "−" : "") +
    formatter.format(Math.abs(amount))
  );
}

export function Money({
  amount,
  currency = "Kč",
  locale,
  className = "",
}: MoneyProps) {
  return (
    <span
      className={`iv-money ${(typeof amount === "string" ? amount.startsWith("-") : amount < 0) ? "is-negative" : ""} ${className}`}
    >
      {formatAmount(amount, locale)}
      {currency && (
        <span className="iv-money-cur">
          {" "}
          {/* eslint-disable-next-line no-restricted-syntax -- a currency symbol, the same in every locale */}
          {currency === "CZK" ? "Kč" : currency}
        </span>
      )}
    </span>
  );
}
