"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  Wifi, WifiOff, Globe, ShieldOff, ShieldCheck,
  Eye, AlertTriangle, ArrowRight, AppWindow,
  Activity, TrendingUp, Clock, Zap, Radio,
} from "lucide-react";
import { useMonitor } from "../../context/MonitorContext";
import { Switch } from "../../components/ui/switch";
import styles from "./page.module.css";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "unknown"; }
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const numTs = typeof ts === "string" ? Number(ts) : ts;
  const diff = Math.max(0, Math.floor((Date.now() - numTs) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(numTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function faviconUrl(domain) {
  const url = new URL("https://www.google.com/s2/favicons");
  url.searchParams.set("domain", domain);
  url.searchParams.set("sz", "32");
  return url.toString();
}

/* ── Features Page ───────────────────────────────────────────────────────── */

export default function FeaturesPage() {
  const {
    wsStatus, liveEntries, newAlertCount,
    openTabs, internetBlocked, toggleInternetBlock,
    focusMode, selectedUserLabel,
  } = useMonitor();

  const backendConnected = wsStatus === "connected";

  // Computed stats
  const stats = useMemo(() => {
    const sitesSet = new Set();
    let blocked = 0;
    const domainCount = {};

    for (const entry of liveEntries) {
      const d = entry.domain || extractDomain(entry.url || "");
      if (d) {
        sitesSet.add(d);
        domainCount[d] = (domainCount[d] || 0) + 1;
      }
      if (entry.action === "blocked") blocked++;
    }

    let topDomain = "—";
    let topCount = 0;
    for (const [domain, count] of Object.entries(domainCount)) {
      if (count > topCount) { topDomain = domain; topCount = count; }
    }

    return {
      sitesVisited: sitesSet.size,
      blockedAttempts: blocked,
      activeTabs: openTabs.length,
      topDomain,
    };
  }, [liveEntries, openTabs]);

  // Recent entries for feed
  const recentEntries = liveEntries.slice(0, 6);
  const latestAlerts = liveEntries.filter((e) => e.action === "blocked").slice(0, 3);

  // Unique windows from openTabs
  const windowCount = useMemo(() => {
    const wins = new Set(openTabs.map((t) => t.windowId));
    return wins.size || 1;
  }, [openTabs]);

  return (
    <div className={styles.page}>
      {/* ── Page Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Zap size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Features</h1>
            <p className={styles.subtitle}>Controls, activity &amp; monitoring overview for {selectedUserLabel}</p>
          </div>
        </div>
      </div>

      {/* ── Quick Status Row ── */}
      <div className={styles.statusRow}>
        {/* Internet Status */}
        <div className={styles.statusCard}>
          <div className={`${styles.statusCardIcon} ${internetBlocked ? styles.iconRed : styles.iconGreen}`}>
            {internetBlocked ? <WifiOff size={20} strokeWidth={2} /> : <Wifi size={20} strokeWidth={2} />}
          </div>
          <div className={styles.statusCardBody}>
            <div className={styles.statusCardLabel}>Internet</div>
            <div className={`${styles.statusCardValue} ${internetBlocked ? styles.textRed : styles.textGreen}`}>
              {internetBlocked ? "Blocked" : "Active"}
            </div>
          </div>
          <Switch
            checked={internetBlocked}
            onCheckedChange={toggleInternetBlock}
            disabled={!backendConnected}
            aria-label={internetBlocked ? "Unblock internet" : "Block internet"}
          />
        </div>

        {/* Focus Mode */}
        <div className={styles.statusCard}>
          <div className={`${styles.statusCardIcon} ${focusMode.enabled ? styles.iconPurple : ""}`}>
            <Eye size={20} strokeWidth={2} />
          </div>
          <div className={styles.statusCardBody}>
            <div className={styles.statusCardLabel}>Focus Mode</div>
            <div className={styles.statusCardValue}>
              {focusMode.enabled ? "Enabled" : "Disabled"}
            </div>
            {focusMode.enabled && focusMode.allowedDomains.length > 0 && (
              <div className={styles.statusCardSub}>
                {focusMode.allowedDomains.length} domain{focusMode.allowedDomains.length !== 1 ? "s" : ""} allowed
              </div>
            )}
          </div>
        </div>

        {/* Security Score */}
        <div className={styles.statusCard}>
          <div className={styles.scoreRing}>
            <svg viewBox="0 0 80 80" className={styles.scoreRingSvg}>
              <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(80,120,200,0.1)" strokeWidth="6" />
              <circle
                cx="40" cy="40" r="34"
                fill="none"
                stroke="url(#scoreGrad)"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${0.98 * 2 * Math.PI * 34} ${2 * Math.PI * 34}`}
                transform="rotate(-90 40 40)"
              />
              <defs>
                <linearGradient id="scoreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#00f0ff" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
            <div className={styles.scoreValue}>98%</div>
          </div>
          <div className={styles.statusCardBody}>
            <div className={styles.statusCardLabel}>Security Score</div>
            <div className={styles.statusCardValueDim}>Excellent</div>
          </div>
        </div>
      </div>

      {/* ── Main Content Grid ── */}
      <div className={styles.mainGrid}>
        {/* Left Column */}
        <div className={styles.leftCol}>
          {/* Recent Activity Feed */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <Activity size={15} strokeWidth={2} />
                Recent Activity
              </div>
              <Link href="/activity" className={styles.cardLink}>
                View all <ArrowRight size={12} strokeWidth={2} />
              </Link>
            </div>
            {recentEntries.length > 0 ? (
              <div className={styles.activityScroll}>
                {recentEntries.map((entry, i) => {
                  const domain = entry.domain || extractDomain(entry.url || "");
                  const blocked = entry.action === "blocked";
                  return (
                    <div key={entry.id || i} className={styles.activityCard}>
                      <div className={styles.activityCardTop}>
                        <img
                          src={faviconUrl(domain)}
                          alt=""
                          width={16}
                          height={16}
                          className={styles.activityFavicon}
                          onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                        />
                        <span className={`${styles.activityBadge} ${blocked ? styles.activityBadgeBlocked : styles.activityBadgeAllowed}`}>
                          {blocked ? "Blocked" : "Allowed"}
                        </span>
                      </div>
                      <div className={styles.activityTitle} title={entry.title || entry.url}>
                        {entry.title || domain}
                      </div>
                      <div className={styles.activityDomain}>{domain}</div>
                      <div className={styles.activityTime}>
                        <Clock size={10} strokeWidth={2} />
                        {formatRelativeTime(entry.timestamp)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.emptyState}>
                <Radio size={28} strokeWidth={1.2} />
                <span>No recent activity</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className={styles.rightCol}>
          {/* Open Tabs Summary */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <AppWindow size={15} strokeWidth={2} />
                Open Tabs
              </div>
              <Link href="/tabs" className={styles.cardLink}>
                View all <ArrowRight size={12} strokeWidth={2} />
              </Link>
            </div>
            {openTabs.length > 0 ? (
              <>
                <div className={styles.tabsSummary}>
                  {openTabs.length} tab{openTabs.length !== 1 ? "s" : ""} across {windowCount} window{windowCount !== 1 ? "s" : ""}
                </div>
                <div className={styles.tabsList}>
                  {openTabs.slice(0, 5).map((tab, i) => {
                    const domain = extractDomain(tab.url || "");
                    return (
                      <div key={tab.id || i} className={styles.tabRow}>
                        <img
                          src={faviconUrl(domain)}
                          alt=""
                          width={14}
                          height={14}
                          className={styles.tabFavicon}
                          onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                        />
                        <span className={styles.tabTitle} title={tab.title || tab.url}>
                          {tab.title || domain}
                        </span>
                      </div>
                    );
                  })}
                  {openTabs.length > 5 && (
                    <div className={styles.tabMore}>+{openTabs.length - 5} more</div>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.emptyState}>
                <AppWindow size={28} strokeWidth={1.2} />
                <span>No open tabs reported</span>
              </div>
            )}
          </div>

          {/* Alerts Panel */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <AlertTriangle size={15} strokeWidth={2} />
                Alerts
                {newAlertCount > 0 && (
                  <span className={styles.alertBadge}>{newAlertCount > 99 ? "99+" : newAlertCount}</span>
                )}
              </div>
              <Link href="/alerts" className={styles.cardLink}>
                View all <ArrowRight size={12} strokeWidth={2} />
              </Link>
            </div>
            {latestAlerts.length > 0 ? (
              <div className={styles.alertList}>
                {latestAlerts.map((entry, i) => {
                  const domain = entry.domain || extractDomain(entry.url || "");
                  return (
                    <div key={entry.id || i} className={styles.alertRow}>
                      <div className={styles.alertIcon}>
                        <ShieldOff size={13} strokeWidth={2.5} />
                      </div>
                      <div className={styles.alertContent}>
                        <div className={styles.alertTitle}>{entry.title || domain}</div>
                        {entry.reason && <div className={styles.alertReason}>{entry.reason}</div>}
                      </div>
                      <div className={styles.alertTime}>{formatRelativeTime(entry.timestamp)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.emptyState}>
                <ShieldCheck size={32} strokeWidth={1.2} />
                <span>No blocked attempts</span>
                <span className={styles.emptyStateSub}>All clear — no threats detected</span>
              </div>
            )}
          </div>

          {/* Quick Stats */}
          <div className={styles.miniGrid}>
            <div className={styles.miniCard}>
              <Globe size={18} strokeWidth={1.8} className={styles.miniIcon} />
              <div className={styles.miniValue}>{stats.sitesVisited}</div>
              <div className={styles.miniLabel}>Sites Visited</div>
            </div>
            <div className={styles.miniCard}>
              <ShieldOff size={18} strokeWidth={1.8} className={`${styles.miniIcon} ${styles.miniIconRed}`} />
              <div className={styles.miniValue}>{stats.blockedAttempts}</div>
              <div className={styles.miniLabel}>Blocked</div>
            </div>
            <div className={styles.miniCard}>
              <AppWindow size={18} strokeWidth={1.8} className={styles.miniIcon} />
              <div className={styles.miniValue}>{stats.activeTabs}</div>
              <div className={styles.miniLabel}>Active Tabs</div>
            </div>
            <div className={styles.miniCard}>
              <TrendingUp size={18} strokeWidth={1.8} className={`${styles.miniIcon} ${styles.miniIconPurple}`} />
              <div className={styles.miniValue} title={stats.topDomain}>
                {stats.topDomain.length > 12 ? stats.topDomain.slice(0, 12) + "…" : stats.topDomain}
              </div>
              <div className={styles.miniLabel}>Top Domain</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
