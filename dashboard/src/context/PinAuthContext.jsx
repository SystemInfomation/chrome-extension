"use client";

/**
 * PinAuthContext — PIN-based authentication gate for the dashboard.
 *
 * Provides:
 *  - isAuthenticated:  boolean — whether user has entered the correct PIN
 *  - isLocked:         boolean — whether the account is locked due to too many failures
 *  - failedAttempts:   number  — current consecutive failed attempts
 *  - lockRemaining:    number  — seconds remaining on lockout
 *  - authenticate(pin): attempt to authenticate with the given PIN
 *  - lock():           manually lock the dashboard
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

/**
 * SHA-256 hash of the PIN for secure comparison.
 * Pre-computed hash of "0000" — we never store the PIN in plain text.
 */
const PIN_HASH = "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0";

/** Maximum failed attempts before lockout. */
const MAX_ATTEMPTS = 5;

/** Lockout duration in seconds (doubles with each lockout). */
const BASE_LOCKOUT_SECONDS = 30;

/** Auto-lock after this many seconds of inactivity. */
const AUTO_LOCK_TIMEOUT_SECONDS = 300; // 5 minutes

const SESSION_KEY = "watson_ct_pin_session";
const LOCKOUT_KEY = "watson_ct_pin_lockout";

const PinAuthContext = createContext(null);

/**
 * Hash a string using SHA-256 and return the hex digest.
 * @param {string} text
 * @returns {Promise<string>}
 */
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function PinAuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockUntil, setLockUntil] = useState(0);
  const [lockRemaining, setLockRemaining] = useState(0);
  const [lockoutCount, setLockoutCount] = useState(0);
  const activityTimerRef = useRef(null);
  const lockTimerRef = useRef(null);

  const isLocked = lockRemaining > 0;

  // Restore lockout state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCKOUT_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        if (data.lockUntil && data.lockUntil > Date.now()) {
          setLockUntil(data.lockUntil);
          setFailedAttempts(data.failedAttempts || 0);
          setLockoutCount(data.lockoutCount || 0);
        } else {
          // Preserve lockout count so escalation persists
          setLockoutCount(data.lockoutCount || 0);
        }
      }
    } catch { /* ignore */ }

    // Check for existing session
    try {
      const session = sessionStorage.getItem(SESSION_KEY);
      if (session === "active") {
        setIsAuthenticated(true);
      }
    } catch { /* ignore */ }
  }, []);

  // Lockout countdown timer
  useEffect(() => {
    if (lockUntil <= Date.now()) {
      setLockRemaining(0);
      return;
    }

    function tick() {
      const remaining = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
      setLockRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(lockTimerRef.current);
      }
    }

    tick();
    lockTimerRef.current = setInterval(tick, 1000);
    return () => clearInterval(lockTimerRef.current);
  }, [lockUntil]);

  // Auto-lock on inactivity
  useEffect(() => {
    if (!isAuthenticated) return;

    function resetTimer() {
      clearTimeout(activityTimerRef.current);
      activityTimerRef.current = setTimeout(() => {
        setIsAuthenticated(false);
        try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      }, AUTO_LOCK_TIMEOUT_SECONDS * 1000);
    }

    const events = ["mousemove", "keydown", "mousedown", "scroll", "touchstart"];
    for (const event of events) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    resetTimer();

    return () => {
      clearTimeout(activityTimerRef.current);
      for (const event of events) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [isAuthenticated]);

  // Persist lockout state
  useEffect(() => {
    try {
      localStorage.setItem(LOCKOUT_KEY, JSON.stringify({
        lockUntil,
        failedAttempts,
        lockoutCount,
      }));
    } catch { /* ignore */ }
  }, [lockUntil, failedAttempts, lockoutCount]);

  const authenticate = useCallback(async (pin) => {
    // Reject if currently locked out
    if (lockUntil > Date.now()) {
      return false;
    }

    const hash = await sha256(pin);
    const valid = timingSafeEqual(hash, PIN_HASH);

    if (valid) {
      setIsAuthenticated(true);
      setFailedAttempts(0);
      try { sessionStorage.setItem(SESSION_KEY, "active"); } catch { /* ignore */ }
      return true;
    }

    // Failed attempt
    const newAttempts = failedAttempts + 1;
    setFailedAttempts(newAttempts);

    if (newAttempts >= MAX_ATTEMPTS) {
      // Escalating lockout: 30s, 60s, 120s, 240s...
      const newLockoutCount = lockoutCount + 1;
      setLockoutCount(newLockoutCount);
      const lockDuration = BASE_LOCKOUT_SECONDS * Math.pow(2, newLockoutCount - 1);
      const until = Date.now() + lockDuration * 1000;
      setLockUntil(until);
      setFailedAttempts(0); // reset attempts counter after lockout triggers
    }

    return false;
  }, [failedAttempts, lockUntil, lockoutCount]);

  const lock = useCallback(() => {
    setIsAuthenticated(false);
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }, []);

  return (
    <PinAuthContext.Provider
      value={{
        isAuthenticated,
        isLocked,
        failedAttempts,
        lockRemaining,
        maxAttempts: MAX_ATTEMPTS,
        authenticate,
        lock,
      }}
    >
      {children}
    </PinAuthContext.Provider>
  );
}

export function usePinAuth() {
  const ctx = useContext(PinAuthContext);
  if (!ctx) throw new Error("usePinAuth must be used inside <PinAuthProvider>");
  return ctx;
}
