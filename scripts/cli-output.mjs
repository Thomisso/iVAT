import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

/** Shared safe diagnostics for local CLI processes. */
export function redactCliOutput(text) {
  return stripVTControlCharacters(text)
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]+@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:(?:NEXT_PUBLIC_)?SUPABASE_)?(?:S3_PROTOCOL_ACCESS_KEY_(?:ID|SECRET)|PUBLISHABLE(?:[_ ]KEY)?|SECRET(?:[_ ]KEY)?|API[_ ]KEY|ANON(?:[_ ]KEY)?|SERVICE[_ -]ROLE(?:[_ ]KEY)?|JWT(?:[_ ]SECRET)?|ACCESS[_ ]KEY(?:[_ ]ID)?|(?:DB|DATABASE|POSTGRES|PG|SMTP)[_ ]?(?:PASSWORD|PASS)|(?:ACCESS|REFRESH|AUTH)[_ ]TOKEN|(?:CLIENT|SIGNING)[_ ]SECRET|PASSWORD|TOKEN|AUTHORIZATION|SMTP_PASS)["']?\s*[:=│|]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]+)/gi,
      (_match, prefix, value) => `${prefix}${value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"}`);
}

/** Wait for complete lines: a chunk boundary must never expose a token prefix. */
export function redactedCliStream() {
  const decoder = new StringDecoder("utf8");
  const limit = 64 * 1024;
  let pending = "";
  let omitted = false;
  function consume(stream, text, final = false) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!omitted) {
        if (pending.length + lines[index].length > limit) {
          pending = "";
          omitted = true;
        } else pending += lines[index];
      }
      if (index < lines.length - 1 || final) {
        stream.push(omitted ? "[oversized CLI line omitted]\n" : redactCliOutput(pending) + (index < lines.length - 1 ? "\n" : ""));
        pending = "";
        omitted = false;
      }
    }
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      consume(this, decoder.write(chunk));
      done();
    },
    flush(done) {
      consume(this, decoder.end(), true);
      done();
    },
  });
}
