/**
 * webpack.config.js — bundles the Chrome extension background service worker
 *
 * Input:  extension/background.js  (ES module, imports link-shield)
 * Output: extension/dist/background.bundle.js  (single script for MV3)
 *
 * Build: npm run build  (or  npx webpack)
 */

const path = require("path");

module.exports = {
  mode: "production",

  // Entry point — the background service worker source file
  entry: "./extension/background.js",

  output: {
    filename: "background.bundle.js",
    path: path.resolve(__dirname, "extension/dist"),
  },

  // Resolve Node built-ins that link-shield / punycode reference
  resolve: {
    fallback: {
      punycode: require.resolve("punycode/"),
    },
  },

  // Target: webworker — matches a Chrome extension service worker environment
  target: "webworker",

  optimization: {
    minimize: true,
  },

  // Suppress size warnings for the bundled extension script
  performance: {
    hints: false,
  },
};
