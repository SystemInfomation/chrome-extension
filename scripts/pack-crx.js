/**
 * scripts/pack-crx.js
 *
 * Packs the built extension directory into a CRX3 file and places it at
 * backend/public/extension.crx so the backend can serve it via GET /extension.crx.
 *
 * Usage:
 *   node scripts/pack-crx.js
 *
 * The webpack bundle (extension/dist/background.bundle.js) must already exist
 * before running this script (run `npm run build` first).
 *
 * Signing key:
 *   extension/key.pem — committed RSA 2048 private key used to sign the CRX.
 *   The Chrome extension ID is derived from the SHA-256 hash of the public key.
 */

const path = require("path");
const fs = require("fs");
const ChromeExtension = require("crx");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, "extension");
const KEY_FILE = path.join(EXTENSION_DIR, "key.pem");
const OUT_FILE = path.join(ROOT, "backend", "public", "extension.crx");

async function main() {
  if (!fs.existsSync(KEY_FILE)) {
    console.error("ERROR: extension/key.pem not found.");
    process.exit(1);
  }

  const bundlePath = path.join(EXTENSION_DIR, "dist", "background.bundle.js");
  if (!fs.existsSync(bundlePath)) {
    console.error("ERROR: extension/dist/background.bundle.js not found — run `npm run build` first.");
    process.exit(1);
  }

  const privateKey = fs.readFileSync(KEY_FILE);

  const crx = new ChromeExtension({ privateKey });
  await crx.load(EXTENSION_DIR);
  const crxBuffer = await crx.pack();

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, crxBuffer);

  console.log(`CRX written to ${OUT_FILE} (${crxBuffer.length} bytes)`);
}

main().catch((err) => {
  console.error("pack-crx failed:", err.message);
  process.exit(1);
});
