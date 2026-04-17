/**
 * Offscreen document for InternetWize.
 * Used for DOM-based text parsing (e.g. blocklist processing) without
 * blocking the main service worker thread.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PARSE_BLOCKLIST_TEXT") {
    // Parse a newline-separated domain list and return the domains array
    const lines = (msg.text || "").split("\n");
    const domains = [];
    for (const line of lines) {
      const d = line.trim();
      if (d && d.includes(".") && !d.startsWith("#")) {
        domains.push(d);
      }
    }
    sendResponse({ domains });
    return true;
  }
});
