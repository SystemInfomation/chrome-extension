import { useEffect, useState } from "react";
import { ShieldAlert, Mail } from "lucide-react";
import "./App.css";
import BlockedInfo from "./components/BlockedInfo.jsx";

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

    setBlockedUrl(rawUrl ? decodeURIComponent(rawUrl) : "");
    setReason(rawReason ? decodeURIComponent(rawReason) : "Policy violation detected");
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
