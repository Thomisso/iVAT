/** Amounts are summed in integer halers; no financial value passes through a float. */
export function halers(value: string): bigint {
  return BigInt(value.replace(".", ""));
}
export function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
export function assessedVat(netAmount: string, rate: number): string {
  const numerator = halers(netAmount) * BigInt(rate);
  const absolute = numerator < BigInt(0) ? -numerator : numerator;
  const rounded = (absolute + BigInt(50)) / BigInt(100);
  return amount(numerator < BigInt(0) ? -rounded : rounded);
}
