import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
