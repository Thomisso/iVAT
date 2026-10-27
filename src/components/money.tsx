export interface MoneyProps {
  amount: number;
  currency?: string;
  locale?: string;
  className?: string;
}

export function formatAmount(amount: number, locale = "cs-CZ") {
  return (
    (amount < 0 ? "−" : "") +
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(amount))
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
      className={`iv-money ${amount < 0 ? "is-negative" : ""} ${className}`}
    >
      {formatAmount(amount, locale)}
      {currency && (
        <span className="iv-money-cur">
          {" "}
          {currency === "CZK" ? "Kč" : currency}
        </span>
      )}
    </span>
  );
}
