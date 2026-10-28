import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // ADR-0010: only the worker entrypoint and its test support construct a
  // service-role client. Application modules receive one through their seam.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [
      "worker/index.ts",
      "tests/support/worker.ts",
      "src/application/client.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/application/client", "./client", "**/application/client"],
              importNames: ["asSystemClient"],
              message:
                "Only worker/index.ts and tests/support/worker.ts construct a SystemClient (ADR-0010).",
            },
          ],
        },
      ],
    },
  },
  // CODING_STANDARDS.md, UI and Application layer: user-visible text goes
  // through next-intl, and pages, routes and components reach the database
  // only through src/application/.
  {
    files: ["src/app/**", "src/components/**"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        { noStrings: true, ignoreProps: true, allowedStrings: [" ", "·", ":", ",", "–"] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // jsx-no-literals misses text chosen by `??`, `||` or `? :` inside JSX.
          selector:
            ":matches(JSXElement, JSXFragment) > JSXExpressionContainer > :matches(LogicalExpression, ConditionalExpression) > Literal[raw=/^['\"]/][value=/[^\\s·:,–]/]",
          message: "User-visible text goes through next-intl (CODING_STANDARDS.md, UI).",
        },
        {
          selector:
            "MemberExpression[object.name=/^(client|supabase)$/][property.name=/^(from|rpc|auth|storage|schema)$/]",
          message:
            "Pages, routes and components call a command or query in src/application/, not Supabase (CODING_STANDARDS.md, Application layer).",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reference implementation, ported into src/ rather than imported.
    "design-system/**",
  ]),
]);

export default eslintConfig;
