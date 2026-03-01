import { useEffect, useState, useCallback } from "react";
import "./App.css";
import BlockedInfo from "./components/BlockedInfo.jsx";

const MAX_INPUT_LENGTH = 2048;
const DEFAULT_IP_PLACEHOLDER = "192.168.1.x";

/**
 * Sanitizes a string to prevent XSS attacks.
 * Uses multiple layers of defense:
 * 1. Strips all HTML content using DOM parsing
 * 2. Removes dangerous characters
 * 3. Enforces length limits
 *
 * @param {string} input - The input string to sanitize
 * @returns {string} - The sanitized string (plain text only)
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "string") return "";

  // First, limit length to prevent DoS
  let sanitized = input.slice(0, MAX_INPUT_LENGTH);

  // Use DOM parser to safely extract text content (strips all HTML)
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitized, "text/html");

  // Extract only text content, which automatically strips all tags
  sanitized = doc.body.textContent || "";

  // Additional safety: remove any remaining dangerous characters
  sanitized = sanitized.replace(/[<>'"]/g, "");

  return sanitized;
}

/**
 * Safely decode a URI component, returning empty string on failure.
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * App — root component for the PalsPlan Web Protector blocked page.
 *
 * Reads query-string parameters injected by the Chrome extension:
 *   ?url=<encoded URL>&category=<encoded category>&ip=<ip>&path=<path>
 *
 * Example:
 *   https://blocked.palsplan.app
 *     ?url=https%3A%2F%2Fexample.com
 *     &category=Adult%20Content
 */
export default function App() {
  const [blockedUrl, setBlockedUrl] = useState("");
  const [pathValue, setPathValue] = useState("/");
  const [category, setCategory] = useState("");
  const [ipValue, setIpValue] = useState(DEFAULT_IP_PLACEHOLDER);
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const rawUrl = params.get("url") || params.get("blockedUrl") || "";
    const rawPath = params.get("path") || "";
    const rawCategory = params.get("category") || params.get("reason") || "";
    const rawIp = params.get("ip") || "";

    const url = sanitizeInput(rawUrl ? safeDecode(rawUrl) : "");
    const path = sanitizeInput(rawPath ? safeDecode(rawPath) : "");
    const cat = sanitizeInput(rawCategory ? safeDecode(rawCategory) : "");
    const ip = sanitizeInput(rawIp ? safeDecode(rawIp) : "");

    setBlockedUrl(url);
    setCategory(cat);
    setIpValue(ip || DEFAULT_IP_PLACEHOLDER);

    if (url && !path) {
      try {
        const parsed = new URL(url);
        setPathValue(parsed.pathname || "/");
      } catch {
        setPathValue("/");
      }
    } else {
      setPathValue(path || "/");
    }
  }, []);

  const handleCopyUrl = useCallback(() => {
    if (!blockedUrl) {
      showToast("No URL to copy", "error");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blockedUrl).then(
        () => showToast("URL copied to clipboard", "success"),
        () => showToast("Failed to copy URL", "error")
      );
    } else {
      showToast("Failed to copy URL", "error");
    }
  }, [blockedUrl, showToast]);

  return (
    <div className="page">
      <div className="card">
        <div className="card-inner">
          {/* ── Logo ── */}
          <div className="logo-wrap">
            <img
              src="https://blocked.palsplan.app/shield-icon.svg"
              alt="Organization logo"
            />
          </div>

          {/* ── Heading ── */}
          <h1 className="heading">This webpage is currently blocked.</h1>

          {/* ── Contact ── */}
          <p className="contact-text">
            Please contact <strong>CMCB IT Department</strong> via{" "}
            <a href="mailto:Helpdesk@cmc.vic.edu.au" className="email-link">
              Helpdesk@cmc.vic.edu.au
            </a>{" "}
            for any additional support.
          </p>

          {/* ── Info panel ── */}
          <BlockedInfo
            blockedUrl={blockedUrl}
            pathValue={pathValue}
            category={category}
            ipValue={ipValue}
            onCopyUrl={handleCopyUrl}
          />

          {/* ── Footer ── */}
          <p className="footer-brand">PalsPlan Web Protector</p>
        </div>
      </div>

      {/* ── Toasts ── */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type === "success" ? "toast-success" : "toast-error"}`}
            role="status"
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
