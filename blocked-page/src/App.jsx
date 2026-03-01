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
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [bypassCode, setBypassCode] = useState("");

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

  const handleUnlock = useCallback(() => {
    const code = bypassCode.trim();
    if (!code) {
      showToast("Please enter a bypass code", "error");
      return;
    }

    showToast("Bypass code accepted! Redirecting\u2026", "success");

    let validTarget = false;
    try {
      const u = new URL(blockedUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        validTarget = true;
      }
    } catch {
      /* invalid URL */
    }

    if (!validTarget) {
      showToast("No valid URL to redirect to", "error");
      return;
    }

    setTimeout(() => {
      window.location.href = blockedUrl;
    }, 1500);
  }, [blockedUrl, bypassCode, showToast]);

  const handleBypassKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleUnlock();
      }
    },
    [handleUnlock]
  );

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && modalOpen) {
        setModalOpen(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [modalOpen]);

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

          {/* ── Report helper text ── */}
          <p className="helper-text">
            If you believe this site has been incorrectly blocked, you can{" "}
            <button
              type="button"
              className="report-link"
              onClick={() => setModalOpen(true)}
            >
              report it to your administrator
            </button>
            .
          </p>

          {/* ── Bypass code section ── */}
          <div className="bypass-box">
            <label htmlFor="bypassInput" className="bypass-label">
              Enter your bypass code to unblock this link
            </label>
            <div className="bypass-controls">
              <input
                id="bypassInput"
                type="text"
                placeholder="Bypass code"
                autoComplete="off"
                aria-label="Bypass code"
                className="bypass-input"
                value={bypassCode}
                onChange={(e) => setBypassCode(e.target.value)}
                onKeyDown={handleBypassKeyDown}
              />
              <button
                type="button"
                className="unlock-btn"
                onClick={handleUnlock}
              >
                Unlock
              </button>
            </div>
          </div>

          {/* ── Footer ── */}
          <p className="footer-brand">PalsPlan Web Protector</p>
        </div>
      </div>

      {/* ── Report modal ── */}
      {modalOpen && (
        <div
          className="modal-overlay active"
          role="dialog"
          aria-modal="true"
          aria-label="Report sent confirmation"
        >
          <div
            className="modal-backdrop"
            onClick={() => setModalOpen(false)}
          />
          <div className="modal-dialog">
            <div className="modal-icon-wrap">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="modal-title">Report Sent</h2>
            <p className="modal-text">
              Report sent to IT (demo). Your administrator will review this
              request.
            </p>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setModalOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

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
