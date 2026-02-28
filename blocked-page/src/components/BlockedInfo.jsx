import PropTypes from "prop-types";
import { AlertTriangle } from "lucide-react";

/**
 * BlockedInfo — displays information about the blocked request.
 *
 * Props:
 *  blockedUrl {string}  — the original URL that was blocked
 *  reason     {string}  — human-readable block reason from the extension
 *  timestamp  {string}  — ISO timestamp of the block event
 */
export default function BlockedInfo({ blockedUrl, reason, timestamp }) {
  // Format the timestamp for display
  const formattedTime = (() => {
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
    } catch {
      return timestamp;
    }
  })();

  return (
    <>
      {/* ── Reason ── */}
      <div className="warning-box">
        <AlertTriangle className="warning-box-icon" size={18} />
        <div>
          <div className="warning-label">Block Reason</div>
          <div className="warning-text">{reason || "Policy violation detected"}</div>
        </div>
      </div>

      {/* ── Details ── */}
      <div className="info-section">
        <div className="info-row">
          <span className="info-label">Blocked URL</span>
          <span className="info-value">{blockedUrl || "—"}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Time of Block</span>
          <span className="info-value timestamp">{formattedTime}</span>
        </div>
      </div>
    </>
  );
}

BlockedInfo.propTypes = {
  blockedUrl: PropTypes.string,
  reason: PropTypes.string,
  timestamp: PropTypes.string,
};
