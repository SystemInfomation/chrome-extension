// eslint.config.js — Blocked Page (React 18 + Vite, ES2022)
import js from "@eslint/js";
import globals from "globals";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}", "vite.config.js"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    settings: {
      react: { version: "18" },
    },
    rules: {
      // ESLint core
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always"],
      "no-eval": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // React
      "react/jsx-uses-react": "off",        // not needed with React 17+ JSX transform
      "react/react-in-jsx-scope": "off",    // not needed with React 17+ JSX transform
      "react/jsx-uses-vars": "error",
      "react/prop-types": "warn",
      "react/no-unknown-property": "error",
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-key": "error",

      // React Hooks
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
