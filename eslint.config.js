import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Array indexing under strict mode without noUncheckedIndexedAccess: the
      // non-null assertion is documentation, not a hole. Kept allowed on purpose.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Plain-Node operational scripts (smoke tools): declare the globals they use.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
);
