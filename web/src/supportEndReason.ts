/** Operator-facing explanations for the relay's fixed support end-reason codes. */
const reasons: Record<string, string> = {
  launch_failed: "The endpoint could not start the support helper.",
  launch_consent_timeout:
    "The endpoint did not connect within two minutes. It may be offline, busy, or have no one signed in.",
  operator_stopped: "You ended the session.",
  staff_stopped: "The session was ended on the computer.",
  staff_declined: "The person at the computer declined the request.",
  staff_closed: "The person at the computer closed the support notice.",
  replaced_by_new_session:
    "A new support session was started for this computer, so this one was closed.",
  local_emergency_hotkey:
    "Someone at the computer pressed Ctrl+Alt+Shift+F12 to end support.",
  notice_closed:
    "The support notice on the computer closed (the user signed out or closed it), so sharing their desktop stopped.",
  console_session_changed:
    "The computer switched to another Windows session (user switching or a remote desktop connection) for over 30 seconds.",
  capture_or_relay_failed:
    "The computer could not keep capturing or sending its screen.",
  management_service_disconnected:
    "The RMM agent service on the computer stopped or restarted.",
  selected_display_unavailable: "The selected monitor was disconnected.",
  emergency_hotkey_unavailable:
    "Ctrl+Alt+Shift+F12 could not be registered on the computer, so support did not start.",
  browser_disconnected: "This support window disconnected from the relay.",
  device_disconnected: "The computer disconnected from the relay.",
  browser_transport_failed: "This support window's connection failed.",
  device_transport_failed: "The computer's connection to the relay failed.",
  connection_lost: "The connection stopped responding.",
  session_expired: "The 30-minute session limit was reached.",
  operator_session_revoked: "Your sign-in ended or your account lost operator access.",
  endpoint_revoked: "The endpoint was revoked.",
  server_restarted: "The RMM server restarted.",
  server_shutdown: "The RMM server restarted.",
  message_rate_exceeded: "Too many messages were sent, so the relay ended the session.",
};

export type EndedSupportSession = {
  reason?: string | null;
  launchSummary?: string | null;
};

/** Returns a short sentence explaining why a support session ended, or "" when unknown. */
export function supportEndReason(session?: EndedSupportSession | null): string {
  if (!session?.reason) return "";
  const summary = session.launchSummary?.trim();
  if (session.reason === "launch_failed" && summary) return summary;
  return (
    reasons[session.reason] ||
    `The session ended (${session.reason.replace(/_/g, " ")}).`
  );
}
