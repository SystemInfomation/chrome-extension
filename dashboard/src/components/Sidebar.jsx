"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Shield, List, AlertTriangle, Settings, Lock, AppWindow, LayoutDashboard, Zap } from "lucide-react";
import { useMonitor } from "../context/MonitorContext";
import { usePinAuth } from "../context/PinAuthContext";
import styles from "./Sidebar.module.css";

const NAV = [
  { href: "/",          label: "Live View",    Icon: LayoutDashboard },
  { href: "/features",  label: "Features",     Icon: Zap            },
  { href: "/tabs",      label: "Tabs",         Icon: AppWindow      },
  { href: "/activity",  label: "Activity Log", Icon: List           },
  { href: "/alerts",    label: "Alerts",       Icon: AlertTriangle  },
  { href: "/settings",  label: "Settings",     Icon: Settings       },
];

export default function Sidebar() {
  const pathname                                                    = usePathname();
  const {
    wsStatus,
    extensionOnline,
    newAlertCount,
    openTabs,
    monitoredUsers,
    selectedMonitoredUserId,
    setSelectedMonitoredUserId,
    refreshMonitoredUsers,
  } = useMonitor();
  const { lock }                                                    = usePinAuth();

  const statusColor =
    wsStatus === "connected" && extensionOnline ? "var(--green)"  :
    wsStatus === "connecting"                   ? "var(--yellow)" :
    "var(--red)";

  const statusLabel =
    wsStatus === "connected" && extensionOnline ? "Extension Online"    :
    wsStatus === "connected"                    ? "Dashboard Connected" :
    wsStatus === "connecting"                   ? "Connecting…"         :
    "Disconnected";

  return (
    <aside className={styles.sidebar}>
      {/* Logo */}
      <div className={styles.logo}>
        <div className={styles.logoIcon}>
          <Shield size={18} strokeWidth={2.5} />
        </div>
        <div>
          <div className={styles.logoTitle}>Watson CT</div>
          <div className={styles.logoSub}>Control Tower</div>
        </div>
      </div>

      <div className={styles.userPicker}>
        <label htmlFor="monitored-user-select" className={styles.userPickerLabel}>
          Monitored user
        </label>
        <div className={styles.userPickerRow}>
          <select
            id="monitored-user-select"
            className={styles.userPickerSelect}
            value={selectedMonitoredUserId}
            onChange={(e) => setSelectedMonitoredUserId(e.target.value)}
          >
            {monitoredUsers.map((user) => (
              <option key={user.monitoredUserId} value={user.monitoredUserId}>
                {user.monitoredUserId} {user.online ? "(online)" : "(offline)"}
              </option>
            ))}
          </select>
          <button
            className={styles.userRefreshBtn}
            onClick={refreshMonitoredUsers}
            aria-label="Refresh monitored users"
            title="Refresh users"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className={styles.nav}>
        {NAV.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`${styles.link} ${active ? styles.active : ""}`}
              aria-label={label}
            >
              <span className={styles.linkIcon}>
                <Icon size={16} strokeWidth={2} />
              </span>
              <span className={styles.linkLabel}>{label}</span>
              {href === "/alerts" && newAlertCount > 0 && (
                <span className={styles.badge}>
                  {newAlertCount > 99 ? "99+" : newAlertCount}
                </span>
              )}
              {href === "/tabs" && openTabs.length > 0 && (
                <span className={styles.countBadge}>
                  {openTabs.length}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Status footer */}
      <div className={styles.footer}>
        <span
          className={styles.statusDot}
          style={{ background: statusColor }}
        />
        <span className={styles.statusLabel}>{statusLabel}</span>
        <button className={styles.lockBtn} onClick={lock} title="Lock dashboard" aria-label="Lock dashboard">
          <Lock size={13} strokeWidth={2} />
        </button>
      </div>
    </aside>
  );
}
