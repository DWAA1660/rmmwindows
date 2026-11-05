# Remote support browser handoff — 2026-11-04

## Delivered

- `web/src/RemoteSupport.tsx` exports `RemoteSupport()` with no required props and `openRemoteSupport(endpointId)` for the endpoint button. The opener runs synchronously from the user's click, opens a dedicated resizable support window, and nulls its opener reference.
- Routes: `/support/new?endpointId=...` authenticates, creates a session with a random idempotency key and replaces browser history with `/support/:id`. Direct `/support/:id` authenticates and retrieves that creator-owned session. Root owns route/button integration in `main.tsx`.
- The window displays endpoint/operator, lifecycle status, maximum remaining time, persistent operator **End session**, local **Enable control** toggle, fit/actual-size display, fullscreen, connection/frame age and clear waiting/declined/expired/stopped/paused/disconnected/error states.
- The browser starts in view-only mode. Input additionally requires server `active`, `controlApproved:true`, a connected relay, a recent live frame, no pause, and an explicitly enabled/focused canvas. Losing window focus or hiding the tab releases input and disables local control; it does not silently re-enable on return.
- JPEGs are decoded with `createImageBitmap` and drawn directly to a canvas. No frame gallery, recording, image download, blob URL or browser storage. Only the current canvas pixels remain. A frame is cleared immediately on pause, withdrawal/end, expiry or disconnection; after 10 seconds without a new frame the last image is cleared and control released to avoid displaying stale desktop as live.
- Actual staff mouse appearance comes from the companion-composited cursor inside each JPEG; local remote-control cursor is a crosshair. Screen dimensions and relative pointer coordinates come from the displayed canvas bounds, including fit/actual scaling.

## User policy override

The latest user direction relayed by root explicitly replaces the original explicit-opt-in / staff Stop-button design: show a staff approve/deny notification and **auto-start after 15 seconds unless denied**. The staff companion keeps a visible indicator, with local emergency shortcut **Ctrl+Alt+Shift+F12**, rather than a staff Stop button. Browser copy matches this policy and does not claim explicit approval or a staff Stop button. No frames or input are accepted before the server marks the session active. The operator's End button and local control toggle remain available. Windows countdown/indicator/hotkey implementation is owned by the agent contributor.

## Protocol and input details

- Uses same-origin HttpOnly auth via `/api/auth/me`; viewer/unauthenticated users get a useful error and no socket/session initiation. CSRF nonce stays in component memory and is sent as `X-CSRF-Token` for mutations. No agent credential reaches the browser.
- HTTP: create/get `/api/support/sessions`, `/:id/stop`, `/:id/ticket` according to the root contract.
- WS: `/api/support/:id/stream`, protocols `['rmm-support','ticket.' + ticket]`; the one-use ticket is never placed in a URL. WSS on HTTPS, WS only for local HTTP QA. No automatic reconnect.
- JSON inbound `{type:'state',session,paused,reason}` and `{type:'display',width,height}`; binary inbound JPEG. State controls capability. Oversized (>8 MiB) or invalid images/dimensions are ignored; stale decoded frames cannot overwrite a newer/current-state frame.
- Outbound `{type:'input',action,...}` for move/down/up/wheel/keyDown/keyUp/releaseAll. Pointer x/y normalized/clamped to0..1; buttons0/1/2; move throttled to approximately30Hz. Wheel includes pointer coordinates and a rounded integer delta clamped to±1200.
- Keyboard uses the server-aligned standard `KeyboardEvent.code` allowlist: letters/digits/F1..F12, navigation/modifiers/punctuation/numpad. PrintScreen/Pause and F13+ are excluded. Browser/OS protected shortcuts may remain unavailable. Escape is deliberately local: it releases control; the window does not trap the operator in keyboard capture. IME composing events are not sent.
- Input is released on focus/visibility loss, pointer cancellation/lost capture while a button remains held, session pause/revocation/end, local control disable, close and disconnect. Normal pointer capture release does not incorrectly release a still-held keyboard modifier.
- Pagehide requests best-effort session stop using fetch keepalive and closes the socket. The server remains authoritative for expiry/disconnect cleanup. A stop request failure hides the local desktop, disables input and explicitly reports that server confirmation failed.
- Canvas rendering requires no `img-src blob:` CSP relaxation. Root/server owns WebSocket origin/session/role/ticket validation and audit enforcement.

## Administrator access policy and native Ctrl+Alt+Delete

- Latest user request adds an administrator policy card: `web/src/SupportSettings.tsx` plus its scoped CSS. Root renders `SupportSettings({request,onError})` only for administrators in Settings. Both GET/PATCH `/api/settings/support` return raw `{approvalRequired:boolean,approvalSeconds:integer1..300}`. The form includes **Show approval notice**, a1–300-second timer (default15, disabled/retained while unchecked), Save/Discard, loading/errors/retry and saved feedback.
- Turning the notice off means new sessions connect immediately without an approval form/countdown, including unattended VMs; copy explicitly retains the visible sharing indicator and **Ctrl+Alt+Shift+F12**. It is a global workspace policy, not a per-VM override. Changes apply only to new sessions; existing sessions retain their server snapshot. A disabled timer cannot leave an invalid empty value when the notice is turned off.
- `RemoteSupport` uses each session's `approvalRequired`/`approvalSeconds` snapshot for the actual duration and bypass copy. It no longer hardcodes15seconds as the current policy. Ended sessions explicitly say control is unavailable.
- Added a real **Ctrl+Alt+Delete** toolbar button. It is enabled only with active/approved/live/unpaused control, operator Enable control on, connected socket and the companion's `secureAttention:true` capability. It sends `{type:'secureAttention',requestId:UUID}`, never keyboard events pretending to perform a secure attention sequence. One local request can be pending; it is not retried automatically.
- Browser reads `{type:'capabilities',secureAttention,secureDesktop:false}` and matched `{type:'secureAttentionResult',requestId,success,message}`. Pending expires locally after30seconds (server timeout25seconds). Result is rendered inline with live status/error semantics. Disconnect or session end disables capability and clears pending state. Confirmation means the request was accepted, not proof that Windows switched desktops.
- A persistent explanation states that Windows security/sign-in/protected desktop viewing and control are unsupported: normal desktop frames pause until staff returns. The service must obey existing Software SAS policy (1or3); the app never changes Windows policy. There is no secure sign-in claim or fake key sequence.

## Verification and limits

- `npm run build --prefix web`: strict TypeScript and Vite production build pass after policy/Ctrl+Alt+Delete integration (1592 modules).
- `npm test --prefix web`: existing4 frontend model/progress tests pass. No redundant tests mirroring component implementation were added.
- Root verified isolated synthetic-JPEG rendering, mouse/key down/up/release and End clearing through a normal browser tab. A real popup was created and connected; the automation provider could not directly click/capture that popup, while the equivalent tab route passed interaction. Root owns the next policy/Ctrl+Alt+Delete synthetic checks. No production staff desktop was viewed or controlled by this contributor.
- Clipboard/file transfer/recording, monitor selection, secure/UAC desktop control and automatic reconnect are unavailable. Locked/protected desktops display paused state. Remote desktop policy, actual Windows input/cursor behavior and service/interactive-user lifecycle still require end-to-end verification on a disposable or expressly attended endpoint.
