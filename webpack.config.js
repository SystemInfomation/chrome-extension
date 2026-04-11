/**
 * webpack.config.js — bundles the Chrome extension background service worker
 *
 * Input:  extension/background.js  (ES module, imports link-shield)
 * Output: extension/dist/background.bundle.js  (single script for MV3)
 *
 * Build: npm run build  (or  npx webpack)
 *
 * The BUILD_NUMBER env var is set by CI (github.run_number) so the running
 * extension can compare against the latest GitHub release tag ("build-N").
 */

const path = require("path");
const webpack = require("webpack");

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

  plugins: [
    // Stamp the GitHub Actions run number into the bundle so the running
    // extension knows its own build number for update comparisons.
    // CI must set:  BUILD_NUMBER: ${{ github.run_number }}
    new webpack.DefinePlugin({
      __BUILD_NUMBER__: parseInt(process.env.BUILD_NUMBER || "0", 10),
    }),
  ],
};
