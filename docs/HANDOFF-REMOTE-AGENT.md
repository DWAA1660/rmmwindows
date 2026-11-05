# Windows remote support handoff — 2026-11-04

Implemented in agent/Support*.cs and companion/*.cs; agent and companion version0.1.6. Root integrated the authorized remote_support job, packaging, installer permissions and browser/server contracts.

- LocalSystem selects the active console user (or sole active WTS user), obtains a limited non-elevated primary token, creates the user environment and starts the fixed companion executable on WinSta0\Default. Ambiguous/no-user sessions fail clearly. No service desktop capture or user elevation.
- A random one-use named pipe permits SYSTEM and that user's SID only. Both ends verify the other process PID. Bootstrap/grant stay in memory, never command-line/files/logs; the agent bearer is never given to the companion. Bounded framing handles LF/CRLF and rejects oversized/incomplete messages.
- Admin policy is snapshotted into the grant: approvalRequired(defaulttrue), approvalSeconds(default15,1–300). The visible notice identifies the operator and requested screen/control access; staff may approve/decline or uncheck control. Closing declines; timeout approves selected access. With the form disabled, the persistent indicator/hotkey must be ready before immediate access. This follows the latest user override of initial click-only consent rules.
- A persistent topmost indicator identifies Library IT/operator/mode. No staff Stop button. Ctrl+Alt+Shift+F12 ends locally; registration failure prevents sharing. Remote input cannot click/type into the support window. Local Resume is required after a desktop pause.
- The companion streams primary-display JPEG/cursor, max1600px wide/about3fps/1MiB. Input is normalized mouse plus an explicit key allowlist, ordinary SendInput subject to UIPI. Every access checks original session/Default desktop/display bounds, local permission, expiry and connected/active controller. No images or typed keys are retained.
- Service lease/pipe loss, browser disconnect, staff decline/end, expiry or shutdown stop sharing without reconnect/replay. The launch job completes after verified bootstrap transfer, independently of the live session. Existing jobs remain available during support.
- Native Ctrl+Alt+Delete requests travel back through the PID-verified pipe, UUID/replay/5s gates, then the real LocalSystem service reads existing SoftwareSASGeneration(1/3) and RunImpersonated(targetUser)->sas.dll SendSAS(false). No policy writes/fake key chord. Results use fixed codes; success confirms request only. Missing/blocked policy leaves ordinary support intact.

## Verification

Both projects build with warnings-as-errors. Agent self-tests30/30 pass including local policy/countdown/readiness/expiry/desktop/input/framing and broker UUID/control/rate/replay gates; companion --self-test passes. No real capture, SendInput, SendSAS, service install, registry mutation or WTS helper launch was exercised in these tests. Browser synthetic JPEG/input/SAS-denial feedback and real agent ordinary PowerShell/file integration passed separately (root PROGRESS evidence).

## Required follow-up / limits

A real service-to-user support session still needs a disposable Windows VM lifecycle check: installer RX ACLs, WTS launch, countdown/decline/form-off, visible cursor/indicator/hotkey, mouse/key mapping, local Resume after lock/UAC, service stop/disconnect and native policy-permitted SAS. Do not claim actual staff desktop control verified yet.

Windows sign-in/Winlogon/UAC view/control is NOT implemented. The non-elevated helper requires a signed-in active desktop and pauses on protected desktops/higher-integrity input. Full sign-in support requires a separately scoped SYSTEM desktop transport and disposable-VM validation; a test endpoint has been requested. No SYSTEM interactive helper, UIAccess workaround, driver or secure-desktop bypass was added.

Primary references: [CreateProcessAsUser](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw), [WTSQueryUserToken](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [SendSAS](https://learn.microsoft.com/en-us/windows/win32/api/sas/nf-sas-sendsas).
