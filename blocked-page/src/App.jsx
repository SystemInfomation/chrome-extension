import { useEffect, useState } from "react";
import { ShieldAlert, Mail } from "lucide-react";
import "./App.css";
import BlockedInfo from "./components/BlockedInfo.jsx";

/**
 * Regular expression pattern to match and remove script tags and their content.
 * Matches: <script...>...</script> including attributes and nested content.
 */
const SCRIPT_TAG_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;

/**
 * Cached textarea element for efficient HTML entity decoding.
 * Created once and reused across sanitization calls.
 */
let cachedTextarea = null;

/**
 * Gets or creates the cached textarea element for HTML entity decoding.
 * 
 * @returns {HTMLTextAreaElement} The textarea element
 */
function getTextarea() {
  if (!cachedTextarea) {
    cachedTextarea = document.createElement("textarea");
  }
  return cachedTextarea;
}

/**
 * Sanitizes a string to prevent XSS attacks.
 * Removes any HTML tags and dangerous characters.
 * 
 * @param {string} input - The input string to sanitize
 * @returns {string} - The sanitized string
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "string") return "";
  
  // Remove script tags and their content using the named pattern
  let sanitized = input.replace(SCRIPT_TAG_PATTERN, "");
  sanitized = sanitized.replace(/<[^>]+>/g, "");
  
  // Decode HTML entities to prevent double encoding attacks using cached textarea
  const textarea = getTextarea();
  textarea.innerHTML = sanitized;
  sanitized = textarea.value;
  
  // Remove any remaining dangerous characters
  sanitized = sanitized.replace(/[<>'"]/g, "");
  
  // Limit length to prevent DoS
  return sanitized.slice(0, 2048);
}

/**
 * Validates and sanitizes a URL.
 * 
 * @param {string} url - The URL to validate
 * @returns {string} - The sanitized URL or empty string if invalid
 */
function sanitizeUrl(url) {
  if (!url) return "";
  
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    // If URL parsing fails, return sanitized text
    return sanitizeInput(url);
  }
}

/**
 * App — root component for the PalsPlan Web Protector blocked page.
 *
 * Reads two query-string parameters injected by the Chrome extension:
 *   ?blockedUrl=<encoded URL>&reason=<encoded reason>
 *
 * Example:
 *   https://blocked.palsplan.app
 *     ?blockedUrl=https%3A%2F%2Fexample.com
 *     &reason=Adult%20Content
 */
export default function App() {
  const [blockedUrl, setBlockedUrl] = useState("");
  const [reason, setReason] = useState("");
  const [timestamp, setTimestamp] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const rawUrl = params.get("blockedUrl") || "";
    const rawReason = params.get("reason") || "";

    // Sanitize inputs to prevent XSS
    const sanitizedUrl = sanitizeUrl(rawUrl ? decodeURIComponent(rawUrl) : "");
    const sanitizedReason = sanitizeInput(rawReason ? decodeURIComponent(rawReason) : "Policy violation detected");
    
    setBlockedUrl(sanitizedUrl);
    setReason(sanitizedReason || "Policy violation detected");
    setTimestamp(new Date().toISOString());
  }, []);

  const mailtoHref = `mailto:it@palsplan.app?subject=False%20Positive%20Report&body=URL%3A%20${encodeURIComponent(
    blockedUrl
  )}%0AReason%3A%20${encodeURIComponent(reason)}%0ATimestamp%3A%20${encodeURIComponent(
    timestamp
  )}`;

  return (
    <div className="page">
      <div className="card">
        {/* ── Shield icon ── */}
        <div className="icon-wrapper">
          <ShieldAlert size={44} color="#ff3b5c" strokeWidth={1.6} />
        </div>

        {/* ── Main heading ── */}
        <h1 className="heading">ACCESS BLOCKED</h1>
        <p className="subtitle">
          This site has been restricted by PalsPlan Web Protector
        </p>

        <div className="divider" />

        {/* ── Reason + details ── */}
        <BlockedInfo
          blockedUrl={blockedUrl}
          reason={reason}
          timestamp={timestamp}
        />

        {/* ── Policy note ── */}
        <p className="policy-note">
          This restriction is enforced by company policy for security and
          productivity. Contact your IT administrator if you believe this is a
          mistake.
        </p>

        {/* ── Report button ── */}
        <a href={mailtoHref} className="btn-report">
          <Mail size={14} />
          Report False Positive
        </a>

        {/* ── Branding ── */}
        <div className="branding">PalsPlan Web Protector &mdash; Enterprise Edition</div>
      </div>
    </div>
  );
}
