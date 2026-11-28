// ESLint: JavaScript's and typescript-eslint's recommended rules, and React's
// rules of hooks (a hook after an early return crashes the panel when the
// condition changes; an effect missing a dependency shows stale values).
// `npm run lint` at the root runs it with clippy; `npm test` runs both.
import js from "@eslint/js";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "public", ".model-cache", "src/wasm/pkg", "src/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { "react-hooks": hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
      // `_`: a value left out on purpose (`const { id: _, ...rest } = o`)
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      // `let { a, b } = …` with only `b` reassigned stays one statement
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    files: ["scripts/**/*.{js,mjs}", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
