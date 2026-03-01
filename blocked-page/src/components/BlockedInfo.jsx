import PropTypes from "prop-types";

/**
 * BlockedInfo — displays information about the blocked request.
 *
 * Props:
 *  blockedUrl {string}  — the original URL that was blocked
 *  pathValue  {string}  — the URL path
 *  category   {string}  — the block category/reason
 *  ipValue    {string}  — the user's IP address
 *  onCopyUrl  {function} — callback to copy the blocked URL
 */
export default function BlockedInfo({ blockedUrl, pathValue, category, ipValue, onCopyUrl }) {
  return (
    <div className="info-panel">
      {/* Website */}
      <div className="info-row">
        <span className="info-label">Website</span>
        <span className="info-value">
          <span>{blockedUrl || "\u2014"}</span>
          <button
            type="button"
            title="Copy URL to clipboard"
            aria-label="Copy blocked URL to clipboard"
            className="copy-btn"
            onClick={onCopyUrl}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
          </button>
        </span>
      </div>

      {/* Path */}
      <div className="info-row">
        <span className="info-label">Path</span>
        <span className="info-value">{pathValue || "/"}</span>
      </div>

      {/* Policy Name */}
      <div className="info-row">
        <span className="info-label">Policy Name</span>
        <span className="info-value">Block Unclassified Sites</span>
      </div>

      {/* Rule Type */}
      <div className="info-row">
        <span className="info-label">Rule Type</span>
        <span className="info-value">Standard Filtering</span>
      </div>

      {/* Application / Category */}
      <div className="info-row">
        <span className="info-label">Application/Category</span>
        <span className="info-value">{category || "\u2014"}</span>
      </div>

      {/* Your IP */}
      <div className="info-row">
        <span className="info-label">Your IP</span>
        <span className="info-value">{ipValue || "\u2014"}</span>
      </div>
    </div>
  );
}

BlockedInfo.propTypes = {
  blockedUrl: PropTypes.string,
  pathValue: PropTypes.string,
  category: PropTypes.string,
  ipValue: PropTypes.string,
  onCopyUrl: PropTypes.func,
};
