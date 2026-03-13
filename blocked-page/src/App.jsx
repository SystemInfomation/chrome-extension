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
 * Linewize-inspired light theme.
 *
 * Reads query-string parameters injected by the Chrome extension:
 *   ?url=<encoded URL>&category=<encoded category>&ip=<ip>&path=<path>
 */
export default function App() {
  const [blockedUrl, setBlockedUrl] = useState("");
  const [pathValue, setPathValue] = useState("/");
  const [category, setCategory] = useState("");
  const [ipValue, setIpValue] = useState(DEFAULT_IP_PLACEHOLDER);
  const [toasts, setToasts] = useState([]);
  const [showDetails, setShowDetails] = useState(false);

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
      {/* ── Top Navigation Bar ── */}
      <nav className="navbar">
        <a href="https://palsplan.app" className="navbar-brand" tabIndex={0} aria-label="PalsPlan Web Protector home">
          <img
            src="/secured.png"
            alt="PalsPlan logo"
            className="navbar-logo"
          />
          <div className="navbar-name">
            PalsPlan
            <span>Web Protection</span>
          </div>
        </a>
      </nav>

      {/* ── Decorative Background Shapes ── */}
      <div className="bg-shapes" aria-hidden="true">
        <div className="shape shape-blue" />
        <div className="shape shape-gold" />
        <div className="shape shape-purple" />
        <div className="shape shape-blue-sm" />
        <div className="shape shape-pink" />
      </div>

      {/* ── Main Content ── */}
      <div className="main-content">
        <div className="card">
          <div className="card-inner">
            {/* ── Blocked Icon ── */}
            <div className="blocked-icon-wrap">
              {/* Monitor + document icon */}
              <svg
                className="monitor-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 120 96"
                fill="none"
                aria-hidden="true"
              >
                {/* Monitor frame */}
                <rect x="8" y="8" width="84" height="60" rx="6" stroke="#9ca3af" strokeWidth="4" fill="#f9fafb"/>
                {/* Screen */}
                <rect x="16" y="16" width="68" height="44" rx="2" stroke="#d1d5db" strokeWidth="2" fill="#f3f4f6"/>
                {/* Document lines on screen */}
                <line x1="24" y1="28" x2="60" y2="28" stroke="#d1d5db" strokeWidth="3" strokeLinecap="round"/>
                <line x1="24" y1="36" x2="72" y2="36" stroke="#d1d5db" strokeWidth="3" strokeLinecap="round"/>
                <line x1="24" y1="44" x2="54" y2="44" stroke="#d1d5db" strokeWidth="3" strokeLinecap="round"/>
                {/* Stand */}
                <line x1="50" y1="68" x2="50" y2="80" stroke="#9ca3af" strokeWidth="4" strokeLinecap="round"/>
                <line x1="34" y1="80" x2="66" y2="80" stroke="#9ca3af" strokeWidth="4" strokeLinecap="round"/>
                {/* Sparkle dots */}
                <circle cx="4" cy="28" r="2.5" fill="#d1d5db"/>
                <circle cx="4" cy="44" r="2.5" fill="#d1d5db"/>
                <circle cx="98" cy="22" r="2.5" fill="#d1d5db"/>
                <circle cx="98" cy="50" r="2.5" fill="#d1d5db"/>
              </svg>
              {/* Red "no" circle overlay */}
              <div className="no-sign" aria-hidden="true" />
            </div>

            {/* ── Heading ── */}
            <h1 className="heading">Content Blocked</h1>

            {/* ── Subtitle ── */}
            <p className="subtitle">
              Access to{" "}
              {blockedUrl
                ? <span className="blocked-url-text">{blockedUrl}</span>
                : "this website"
              }{" "}
              has been blocked
            </p>

            {/* ── Toggle Details Button ── */}
            <button
              type="button"
              className={`see-why-btn${showDetails ? " open" : ""}`}
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
            >
              {showDetails ? "Hide details" : "See why it's blocked"}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </button>

            {/* ── Expandable Info Panel ── */}
            <div className={`info-expand${showDetails ? " visible" : ""}`}>
              <BlockedInfo
                blockedUrl={blockedUrl}
                pathValue={pathValue}
                category={category}
                ipValue={ipValue}
                onCopyUrl={handleCopyUrl}
              />
            </div>

            {/* ── Secured Badge ── */}
            <div className="secured-badge">
              <img src="/secured.png" alt="PalsPlan Secured" />
              Secured by PalsPlan
            </div>

            {/* ── Contact ── */}
            <p className="contact-text">
              Contact <strong>PalsPlan IT</strong> via{" "}
              <a href="mailto:blocked@palsplan.app" className="email-link">
                blocked@palsplan.app
              </a>
            </p>

            {/* ── Footer ── */}
            <p className="footer-brand">PalsPlan Web Protector</p>
          </div>
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
