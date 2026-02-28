import { useEffect, useState } from "react";
import { ShieldAlert, Mail } from "lucide-react";
import "./App.css";
import BlockedInfo from "./components/BlockedInfo.jsx";

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
  let sanitized = input.slice(0, 2048);
  
  // Use DOM parser to safely extract text content (strips all HTML)
  // This is more robust than regex-based approaches
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitized, "text/html");
  
  // Extract only text content, which automatically strips all tags
  sanitized = doc.body.textContent || "";
  
  // Additional safety: remove any remaining dangerous characters
  // (should already be clean, but defense in depth)
  sanitized = sanitized.replace(/[<>'"]/g, "");
  
  return sanitized;
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
