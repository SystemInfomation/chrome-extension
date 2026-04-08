"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Shield, Lock, AlertTriangle } from "lucide-react";
import { usePinAuth } from "../context/PinAuthContext";
import styles from "./PinLock.module.css";

const PIN_LENGTH = 4;

export default function PinLock({ children }) {
  const {
    isAuthenticated,
    isLocked,
    failedAttempts,
    lockRemaining,
    maxAttempts,
    authenticate,
  } = usePinAuth();

  const [digits, setDigits] = useState(["", "", "", ""]);
  const [shaking, setShaking] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRefs = useRef([]);

  // Focus first input on mount
  useEffect(() => {
    if (!isAuthenticated && !isLocked) {
      inputRefs.current[0]?.focus();
    }
  }, [isAuthenticated, isLocked]);

  const resetInputs = useCallback(() => {
    setDigits(["", "", "", ""]);
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  }, []);

  const handleDigitChange = useCallback(async (index, value) => {
    // Only accept digits
    const digit = value.replace(/\D/g, "").slice(-1);

    setDigits((prev) => {
      const next = [...prev];
      next[index] = digit;

      // If all digits entered, try to authenticate
      if (digit && index === PIN_LENGTH - 1 && next.every((d) => d !== "")) {
        const pin = next.join("");
        setChecking(true);
        authenticate(pin).then((ok) => {
          setChecking(false);
          if (!ok) {
            setShaking(true);
            setTimeout(() => {
              setShaking(false);
              setDigits(["", "", "", ""]);
              setTimeout(() => inputRefs.current[0]?.focus(), 50);
            }, 500);
          }
        });
      }

      return next;
    });

    // Auto-advance to next input
    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, [authenticate]);

  const handleKeyDown = useCallback((index, e) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      setDigits((prev) => {
        const next = [...prev];
        next[index - 1] = "";
        return next;
      });
    }
  }, [digits]);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, PIN_LENGTH);
    if (pasted.length === PIN_LENGTH) {
      const newDigits = pasted.split("");
      setDigits(newDigits);
      inputRefs.current[PIN_LENGTH - 1]?.focus();
      setChecking(true);
      authenticate(pasted).then((ok) => {
        setChecking(false);
        if (!ok) {
          setShaking(true);
          setTimeout(() => {
            setShaking(false);
            resetInputs();
          }, 500);
        }
      });
    }
  }, [authenticate, resetInputs]);

  // If authenticated, show the app
  if (isAuthenticated) {
    return children;
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} />
      <div className={`${styles.card} ${shaking ? styles.shake : ""}`}>
        {/* Logo */}
        <div className={styles.logoContainer}>
          <div className={styles.logo}>
            <Shield size={28} strokeWidth={2} />
          </div>
          <div className={styles.glow} />
        </div>

        <h1 className={styles.title}>Watson Control Tower</h1>
        <p className={styles.subtitle}>Enter your PIN to access the dashboard</p>

        {/* Lockout state */}
        {isLocked ? (
          <div className={styles.lockout}>
            <div className={styles.lockoutIcon}>
              <Lock size={24} strokeWidth={2} />
            </div>
            <div className={styles.lockoutTitle}>Dashboard Locked</div>
            <div className={styles.lockoutText}>
              Too many failed attempts. Try again in
            </div>
            <div className={styles.lockoutTimer}>
              {Math.floor(lockRemaining / 60)}:{String(lockRemaining % 60).padStart(2, "0")}
            </div>
          </div>
        ) : (
          <>
            {/* PIN inputs */}
            <div className={styles.pinRow}>
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  className={styles.pinInput}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  disabled={checking}
                  autoComplete="off"
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  onPaste={i === 0 ? handlePaste : undefined}
                  aria-label={`PIN digit ${i + 1}`}
                />
              ))}
            </div>

            {/* Failed attempts warning */}
            {failedAttempts > 0 && (
              <div className={styles.warning}>
                <AlertTriangle size={14} strokeWidth={2} />
                Incorrect PIN — {maxAttempts - failedAttempts} attempt{maxAttempts - failedAttempts !== 1 ? "s" : ""} remaining
              </div>
            )}

            {checking && (
              <div className={styles.checking}>Verifying…</div>
            )}
          </>
        )}

        <div className={styles.securityNote}>
          <Lock size={11} strokeWidth={2} />
          Secured with end-to-end encryption
        </div>
      </div>
    </div>
  );
}
