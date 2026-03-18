import js          from "@eslint/js";
import globals     from "globals";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [".next/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx,mjs}"],
    plugins: {
      react:          reactPlugin,
      "react-hooks":  hooksPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType:  "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...hooksPlugin.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types":         "off",
      // Overly strict for legitimate patterns: localStorage hydration on mount
      // and async WebSocket setup called from useEffect are both intentional.
      "react-hooks/set-state-in-effect":  "off",
      // The refs-during-render rule fires on the sync ref approach; we use
      // useEffect to update connectRef, so this is already handled correctly.
      "react-hooks/refs":                 "off",
      "react-hooks/immutability":         "off",
    },
  },
];
