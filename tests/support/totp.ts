import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function totp(secret: string, at = Date.now()): string {
  let bits = "";
  for (const character of secret.replace(/=+$/u, "").toUpperCase()) {
    bits += BASE32.indexOf(character).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    bits.match(/.{8}/gu)?.map((byte) => Number.parseInt(byte, 2)) ?? [],
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return String(value).padStart(6, "0");
}
