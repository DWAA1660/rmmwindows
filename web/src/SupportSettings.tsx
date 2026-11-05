import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import "./SupportSettings.css";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type SupportPolicy = {
  approvalRequired: boolean;
  approvalSeconds: number;
  showSessionDetails: boolean;
};

/** Admin-only policy editor; the server snapshots this policy into each new session. */
export function SupportSettings({
  request,
  onError,
}: {
  request: Request;
  onError: (error: unknown) => void;
}) {
  const [saved, setSaved] = useState<SupportPolicy | null>(null);
  const [approvalRequired, setApprovalRequired] = useState(true),
    [seconds, setSeconds] = useState("15"),
    [showSessionDetails, setShowSessionDetails] = useState(true);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const mounted = useRef(true),
    reportError = useRef(onError);
  reportError.current = onError;
  const acceptPolicy = (policy: SupportPolicy) => {
    if (
      !policy ||
      typeof policy.approvalRequired !== "boolean" ||
      typeof policy.showSessionDetails !== "boolean" ||
      !Number.isInteger(policy.approvalSeconds) ||
      policy.approvalSeconds < 1 ||
      policy.approvalSeconds > 300
    )
      throw new Error("The server returned an invalid remote support policy.");
    setSaved(policy);
    setApprovalRequired(policy.approvalRequired);
    setSeconds(String(policy.approvalSeconds));
    setShowSessionDetails(policy.showSessionDetails);
  };
  const fail = (failure: unknown) => {
    const text = failure instanceof Error ? failure.message : String(failure);
    setError(text);
    reportError.current(failure);
  };
  const load = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const policy = await request<SupportPolicy>("/settings/support");
      if (mounted.current) acceptPolicy(policy);
    } catch (failure) {
      if (mounted.current) fail(failure);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [request]);
  const parsedSeconds = Number(seconds);
  const validSeconds =
    seconds.trim() !== "" &&
    Number.isInteger(parsedSeconds) &&
    parsedSeconds >= 1 &&
    parsedSeconds <= 300;
  const dirty =
    !!saved &&
    (approvalRequired !== saved.approvalRequired ||
      parsedSeconds !== saved.approvalSeconds ||
      showSessionDetails !== saved.showSessionDetails);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!saved || !validSeconds || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const policy = await request<SupportPolicy>(
        "/settings/support",
        "PATCH",
        {
          approvalRequired,
          approvalSeconds: parsedSeconds,
          showSessionDetails,
        },
      );
      if (mounted.current) {
        acceptPolicy(policy);
        setMessage(
          policy.approvalRequired
            ? `Saved. New sessions show a staff notice and start after ${policy.approvalSeconds} second${policy.approvalSeconds === 1 ? "" : "s"} unless declined.${policy.showSessionDetails ? " The sharing indicator stays visible." : " After the initial notice, no banner or icon is shown; the emergency shortcut remains available."}`
            : policy.showSessionDetails
              ? "Saved. New sessions connect immediately with a visible staff indicator."
              : "Saved. Sessions start without a notice, banner, or icon. Ctrl+Alt+Shift+F12 still ends sharing locally.",
        );
      }
    } catch (failure) {
      if (mounted.current) fail(failure);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <section className="panel settings-card support-policy">
      <div className="settings-card-heading">
        <span className="settings-icon">
          <Monitor size={22} />
        </span>
        <div>
          <h2>Remote support access</h2>
          <p>Choose how new support sessions begin.</p>
        </div>
      </div>
      {loading ? (
        <div className="support-policy-loading" role="status">
          <Loader2 size={16} className="spin" />
          Loading remote support settings…
        </div>
      ) : (
        <form onSubmit={save}>
          {error && (
            <div className="support-policy-error" role="alert">
              {error}
              {!saved && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void load()}
                >
                  <RefreshCw size={13} />
                  Try again
                </button>
              )}
            </div>
          )}
          <label className="support-policy-toggle">
            <input
              type="checkbox"
              checked={approvalRequired}
              disabled={!saved || saving}
              onChange={(event) => {
                setApprovalRequired(event.target.checked);
                if (!event.target.checked && !validSeconds)
                  setSeconds(String(saved?.approvalSeconds ?? 15));
                setMessage("");
              }}
            />
            <span>
              <strong>Show approval notice</strong>
              <small>
                Staff can approve or decline. The session starts when the
                countdown finishes if they do not respond.
              </small>
            </span>
          </label>
          <div className="support-policy-timer">
            <label>
              <span>
                <Clock3 size={14} />
                Approval countdown (seconds)
              </span>
              <input
                type="number"
                min={1}
                max={300}
                step={1}
                required
                disabled={!saved || saving || !approvalRequired}
                value={seconds}
                onChange={(event) => {
                  setSeconds(event.target.value);
                  setMessage("");
                }}
                aria-describedby="support-timer-help"
              />
            </label>
            <small id="support-timer-help">
              Choose 1–300 seconds. The default is 15 seconds.
            </small>
          </div>
          <label className="support-policy-toggle">
            <input
              type="checkbox"
              checked={showSessionDetails}
              disabled={!saved || saving}
              onChange={(event) => {
                setShowSessionDetails(event.target.checked);
                setMessage("");
              }}
            />
            <span>
              <strong>Show sharing indicator</strong>
              <small>
                {showSessionDetails
                  ? "Keep the session banner visible on the staff desktop while sharing."
                  : approvalRequired
                    ? "After the initial notice, no banner or icon is shown. Ctrl+Alt+Shift+F12 still ends sharing."
                    : "Sessions start without a notice, banner, or icon. Ctrl+Alt+Shift+F12 still ends sharing locally."}
              </small>
            </span>
          </label>
          {!approvalRequired && (
            <div className="support-policy-immediate">
              <Monitor size={17} />
              <p>
                <strong>
                  Saving applies immediate access to new sessions.
                </strong>{" "}
                No approval form or countdown appears, including on unattended
                VMs.{" "}
                {showSessionDetails
                  ? "The staff desktop shows a persistent sharing indicator."
                  : "No notice, banner, or icon is shown."}{" "}
                <kbd>Ctrl+Alt+Shift+F12</kbd> still ends sharing locally.
              </p>
            </div>
          )}
          <div className="support-policy-scope">
            <ShieldCheck size={15} />
            <p>
              This is a workspace setting for all endpoints. Changes apply to
              new sessions; active sessions keep the policy they started with.
              Only administrators can change it.
            </p>
          </div>
          {message && (
            <div className="support-policy-saved" role="status">
              <CheckCircle2 size={15} />
              <span>{message}</span>
            </div>
          )}
          <div className="support-policy-actions">
            <button
              type="submit"
              className="button primary"
              disabled={!saved || saving || !dirty || !validSeconds}
            >
              {saving ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              Save support settings
            </button>
            {dirty && (
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  if (saved) acceptPolicy(saved);
                  setMessage("");
                  setError("");
                }}
              >
                Discard changes
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
