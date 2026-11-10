#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

const tokens = JSON.parse(fs.readFileSync(new URL("../design-system/tokens.json", import.meta.url), "utf8"));
const spacing = new Map(tokens.spacing.tokens.map(token => [token.value, token.name]));
const colors = new Map();
for (const token of tokens.color.tokens) {
  if (typeof token.value !== "object") continue;
  for (const value of Object.values(token.value)) {
    const color = colorKey(value);
    if (color && !colors.has(color)) colors.set(color, token.name);
  }
}
const spacingProperty = property => /^(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/.test(property)
  || /^(?:(?:row|column)-)?gap$/.test(property);

function spacingReplacement(literal) {
  const match = literal.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(px|rem)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]) * (match[2].toLowerCase() === "rem" ? 16 : 1);
  const token = spacing.get(`${Math.abs(amount)}px`);
  return token && (amount < 0 ? `calc(-1 * var(--${token}))` : `var(--${token})`);
}

const colorProperty = property => /(?:^|-)color$/.test(property)
  || /^(?:background(?:-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|outline|(?:box|text)-shadow|fill|stroke)$/.test(property);

function colorKey(value) {
  const literal = value.toLowerCase();
  if (literal === "white") return "ffffffff";
  if (literal === "black") return "000000ff";
  const hex = literal.match(/^#([a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/)?.[1];
  if (hex) {
    const expanded = hex.length < 5 ? [...hex].map(char => char + char).join("") : hex;
    return expanded.length === 6 ? `${expanded}ff` : expanded;
  }
  const rgb = literal.match(/^rgba?\(([^()]*)\)$/)?.[1];
  if (!rgb) return undefined;
  const parts = rgb.trim().split(/[\s,/]+/);
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const numbers = parts.map((part, index) => {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part)) return NaN;
    const scale = part.endsWith("%") ? 255 / 100 : index === 3 ? 255 : 1;
    return Number.parseFloat(part) * scale;
  });
  if (numbers.some(number => !Number.isFinite(number) || number < 0 || number > 255)) return undefined;
  if (numbers.length === 3) numbers.push(255);
  return numbers.map(number => Math.round(number).toString(16).padStart(2, "0")).join("");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function baseline(explicit) {
  if (explicit) return git("rev-parse", "--verify", "--end-of-options", `${explicit}^{commit}`);
  if (["pull_request", "push"].includes(process.env.GITHUB_EVENT_NAME)) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const revision = process.env.GITHUB_EVENT_NAME === "pull_request" ? event.pull_request?.base?.sha : event.before;
    if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("Missing CI base revision; supply --base REF");
    return git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`);
  }
  return git("merge-base", "origin/main", "HEAD");
}

function identity(declaration) {
  const context = [];
  for (let parent = declaration.parent; parent?.type !== "root"; parent = parent.parent) {
    context.unshift(parent.type === "rule" ? parent.selector : `@${parent.name} ${parent.params}`);
  }
  return JSON.stringify([context, declaration.prop, declaration.value, Boolean(declaration.important)]);
}

function historicalDeclarations(source, file) {
  const counts = new Map();
  postcss.parse(source, { from: file }).walkDecls(declaration => {
    const key = identity(declaration);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

try {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const base = baseline(values.base);
  const baseFiles = new Set(git("ls-tree", "-r", "--name-only", "-z", base, "--", "src").split("\0"));
  const files = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src").split("\0"))].filter(file => file.endsWith(".css") && fs.existsSync(file));
  let failures = 0;
  for (const file of files) {
    const historical = historicalDeclarations(baseFiles.has(file) ? git("show", `${base}:${file}`) : "", file);
    postcss.parse(fs.readFileSync(file, "utf8"), { from: file }).walkDecls(declaration => {
      const key = identity(declaration);
      const remaining = historical.get(key) ?? 0;
      if (remaining) { historical.set(key, remaining - 1); return; }
      const property = declaration.prop.toLowerCase();
      if (property.startsWith("--") || (!spacingProperty(property) && !colorProperty(property))) return;
      const previous = declaration.prev();
      if (previous?.type === "comment" && previous.text.startsWith("token-lint-exception:")) {
        if (!previous.text.slice("token-lint-exception:".length).trim()) {
          const { line, column } = declaration.source.start;
          console.error(`${file}:${line}:${column} token-lint-exception requires a reason`);
          failures++;
        }
        return;
      }
      valueParser(declaration.value).walk(node => {
        if (node.type === "function" && node.value.toLowerCase() === "url") return false;
        const literal = node.type === "function" ? valueParser.stringify(node) : node.value;
        const color = colorProperty(property) && ["word", "function"].includes(node.type) && colors.get(colorKey(literal));
        const replacement = spacingProperty(property)
          ? node.type === "word" && spacingReplacement(literal)
          : color && `var(--${color})`;
        if (replacement) {
          const { line, column } = declaration.source.start;
          console.error(`${file}:${line}:${column} ${declaration.prop}: ${literal} → ${replacement}`);
          failures++;
        }
      });
    });
  }
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  console.error(`CSS token lint: ${error.message}\nChoose an available comparison with --base REF; CI requires complete Git history.`);
  process.exitCode = 1;
}
