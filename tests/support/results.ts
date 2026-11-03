import { expect } from "vitest";
import type { Result } from "@/application/client";

/** Assert the command/query succeeded before checking its domain value. */
export function succeeded<T, E extends string>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
