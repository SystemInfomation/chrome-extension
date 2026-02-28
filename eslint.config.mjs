// eslint.config.js — Extension (Manifest V3 service worker, ES2022)
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["extension/**/*.js", "webpack.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Chrome extension APIs available in a service worker
        ...globals.browser,
        chrome: "readonly",
        URLSearchParams: "readonly",
        URL: "readonly",
        Map: "readonly",
        Set: "readonly",
        RegExp: "readonly",
        console: "readonly",
      },
    },
    rules: {
      // Errors
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",

      // Warnings
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // webpack config runs in Node, so needs Node globals
    files: ["webpack.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
];
