import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Keyboard,
  Loader2,
  LockKeyhole,
  Maximize2,
  Monitor,
  MousePointer2,
  Power,
  ShieldCheck,
  Signal,
  WifiOff,
  XCircle,
} from "lucide-react";
import "./RemoteSupport.css";
import { supportEndReason } from "./supportEndReason";

type SupportStatus =
  | "requested"
  | "awaiting_consent"
  | "active"
  | "declined"
  | "stopped"
  | "expired"
  | "failed";
export type SupportSession = {
  id: string;
  endpointId: string;
  endpointName: string;
  operatorName: string;
  status: SupportStatus;
  expiresAt: string;
  requestedControl: boolean;
  controlApproved: boolean;
  approvalRequired: boolean;
  approvalSeconds: number;
  showSessionDetails: boolean;
  jobId?: string;
  reason?: string | null;
  launchSummary?: string | null;
  consentUser?: string | null;
};
type SupportInput = {
  type: "input";
  action: "move" | "down" | "up" | "wheel" | "keyDown" | "keyUp" | "releaseAll";
  x?: number;
  y?: number;
  button?: 0 | 1 | 2;
  deltaY?: number;
  key?: string;
};
type SupportDisplay = {
  id: string;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
};
type StreamMessage =
  | {
      type: "state";
      session: SupportSession;
      paused?: boolean;
      reason?: string;
    }
  | { type: "display"; id?: string; width: number; height: number }
  | { type: "displays"; displays: SupportDisplay[] }
  | { type: "capabilities"; secureAttention: boolean; secureDesktop: boolean }
  | {
      type: "secureAttentionResult";
      requestId: string;
      success: boolean;
      message: string;
    };
const terminal = (status?: SupportStatus) =>
  !!status && ["declined", "stopped", "expired", "failed"].includes(status);
const allowedKey = (code: string) =>
  /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2]))$/.test(code) ||
  new Set([
    "Escape",
    "Backspace",
    "Tab",
    "Enter",
    "Space",
    "Insert",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "NumpadMultiply",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadDecimal",
    "NumpadDivide",
    "NumpadEnter",
  ]).has(code);

/** Call directly from a user click so browsers permit the dedicated support window. */
export function openRemoteSupport(endpointId: string): Window | null {
  const popup = window.open(
    `/support/new?endpointId=${encodeURIComponent(endpointId)}`,
    "_blank",
    "popup,width=1360,height=900,resizable=yes,scrollbars=yes",
  );
  if (popup) popup.opener = null;
  return popup;
}

/**
 * Remote support with the administrator-configured staff notice. This component owns its same-origin login/CSRF handshake;
 * it never receives an agent credential, reads a clipboard, or stores screen frames.
 * Root renders it for /support/new and /support/:id before the main console App.
 */
export function RemoteSupport() {
  const [session, setSession] = useState<SupportSession | null>(null);
  const [userName, setUserName] = useState("");
  const [connecting, setConnecting] = useState(true),
    [connected, setConnected] = useState(false);
  const [error, setError] = useState(""),
    [paused, setPaused] = useState(false),
    [pauseReason, setPauseReason] = useState("");
  const [hasFrame, setHasFrame] = useState(false),
    [stale, setStale] = useState(false),
    [frameAt, setFrameAt] = useState(0);
  const [controlEnabled, setControlEnabled] = useState(false),
    [focused, setFocused] = useState(false),
    [stopping, setStopping] = useState(false),
    [localStopped, setLocalStopped] = useState(false);
  const [display, setDisplay] = useState({ width: 0, height: 0 }),
    [scale, setScale] = useState<"fit" | "actual">("fit"),
    [now, setNow] = useState(Date.now());
  const [displays, setDisplays] = useState<SupportDisplay[]>([]),
    [selectedDisplayId, setSelectedDisplayId] = useState(""),
    [switchingDisplay, setSwitchingDisplay] = useState(false);
  const activeDisplayId = useRef<string | null>(null),
    requestedDisplayId = useRef<string | null>(null),
    displaySwitchConfirmed = useRef(false),
    displaySwitchResumed = useRef(false);
  const [secureAttentionAvailable, setSecureAttentionAvailable] =
      useState(false),
    [secureAttentionPending, setSecureAttentionPending] = useState(false),
    [secureAttentionFeedback, setSecureAttentionFeedback] = useState<{
      success: boolean;
      message: string;
    } | null>(null);
  const secureAttentionRequest = useRef<string | null>(null),
    secureAttentionTimer = useRef<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    stage = useRef<HTMLDivElement>(null),
    socket = useRef<WebSocket | null>(null);
  const currentSession = useRef<SupportSession | null>(null),
    csrf = useRef(""),
    currentPaused = useRef(false),
    stopped = useRef(false),
    disposed = useRef(false),
    frameSequence = useRef(0);
  const lastFrame = useRef(0),
    pressedKeys = useRef(new Set<string>()),
    pressedButtons = useRef(new Set<number>()),
    moveTimer = useRef<number | null>(null),
    pendingMove = useRef<{ x: number; y: number } | null>(null);
  const control = useRef(false),
    canInput = useRef(false),
    framePresent = useRef(false),
    connectedRef = useRef(false);

  const clearFrame = () => {
    // Clear sensitive pixels promptly on pause, session withdrawal, stop or disconnect.
    frameSequence.current++;
    const context = canvas.current?.getContext("2d");
    if (context && canvas.current)
      context.clearRect(0, 0, canvas.current.width, canvas.current.height);
    framePresent.current = false;
    setHasFrame(false);
  };
  const send = (message: SupportInput) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  };
  const releaseAll = () => {
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = null;
    pendingMove.current = null;
    // Release is allowed without local control so revoked focus cannot leave keys held.
    if (pressedKeys.current.size || pressedButtons.current.size)
      send({ type: "input", action: "releaseAll" });
    pressedKeys.current.clear();
    pressedButtons.current.clear();
  };
  const disableControl = () => {
    releaseAll();
    control.current = false;
    canInput.current = false;
    setControlEnabled(false);
    setFocused(false);
  };
  const request = async <T,>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-CSRF-Token": csrf.current } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const details = await response.json();
        message = details.error || message;
      } catch {
        /* Reverse proxies can return non-JSON errors. */
      }
      if (response.status === 401)
        message =
          "Your sign-in expired. Return to the workspace, sign in, then start a new support session.";
      throw new Error(message);
    }
    return response.status === 204 ? (undefined as T) : response.json();
  };
  const acceptSession = (next: SupportSession) => {
    if (!next || typeof next.id !== "string" || !next.status) return;
    currentSession.current = next;
    setSession(next);
    if (next.status !== "active" || !next.controlApproved) disableControl();
    if (next.status !== "active") clearFrame();
    if (terminal(next.status)) {
      stopped.current = true;
      requestedDisplayId.current = null;
      setSwitchingDisplay(false);
      setSecureAttentionAvailable(false);
      setSecureAttentionPending(false);
      secureAttentionRequest.current = null;
      if (secureAttentionTimer.current !== null)
        window.clearTimeout(secureAttentionTimer.current);
      socket.current?.close(1000, "Support session ended");
    }
  };

  useEffect(() => {
    disposed.current = false;
    let statePoll: number | undefined;
    const readState = async () => {
      if (!currentSession.current || disposed.current) return;
      try {
        const next = await request<SupportSession>(
          `/support/sessions/${currentSession.current.id}`,
        );
        if (!disposed.current) acceptSession(next);
      } catch (err) {
        if (!disposed.current) setError((err as Error).message);
      }
    };
    const start = async () => {
      try {
        const auth = await request<{
          user: { username: string; role: string };
          csrfToken: string;
        }>("/auth/me");
        if (disposed.current) return;
        csrf.current = auth.csrfToken;
        setUserName(auth.user.username);
        if (!["admin", "operator"].includes(auth.user.role))
          throw new Error(
            "Remote support is available to administrators and operators. Viewer accounts cannot start or control a session.",
          );
        const route = window.location.pathname.match(/^\/support\/([^/]+)\/?$/);
        const identifier = route?.[1];
        if (!identifier)
          throw new Error(
            "This support link is incomplete. Start a session from an endpoint in the workspace.",
          );
        let next: SupportSession;
        if (identifier === "new") {
          const endpointId = new URLSearchParams(window.location.search).get(
            "endpointId",
          );
          if (!endpointId)
            throw new Error(
              "No endpoint was selected. Return to the workspace to start a session.",
            );
          next = await request<SupportSession>("/support/sessions", "POST", {
            endpointId,
            requestedControl: true,
            idempotencyKey: crypto.randomUUID(),
          });
          if (disposed.current) return;
          window.history.replaceState(
            null,
            "",
            `/support/${encodeURIComponent(next.id)}`,
          );
        } else
          next = await request<SupportSession>(
            `/support/sessions/${encodeURIComponent(identifier)}`,
          );
        if (disposed.current) return;
        acceptSession(next);
        document.title = `${next.endpointName} · Remote support · Library`;
        if (terminal(next.status)) {
          setConnecting(false);
          return;
        }
        const ticket = await request<{ ticket: string }>(
          `/support/sessions/${next.id}/ticket`,
          "POST",
          {},
        );
        if (disposed.current) return;
        const url = new URL(
          `/api/support/${encodeURIComponent(next.id)}/stream`,
          window.location.origin,
        );
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        // One-use short-lived ticket is sent as a subprotocol, never in a logged URL.
        const ws = new WebSocket(url, [
          "rmm-support",
          `ticket.${ticket.ticket}`,
        ]);
        ws.binaryType = "blob";
        socket.current = ws;
        ws.onopen = () => {
          if (!disposed.current) {
            connectedRef.current = true;
            setConnected(true);
            setConnecting(false);
            setError("");
          }
        };
        ws.onmessage = async (event) => {
          if (disposed.current || stopped.current) return;
          if (typeof event.data === "string") {
            try {
              const message = JSON.parse(event.data) as StreamMessage;
              if (message.type === "state") {
                const isPaused = message.paused === true;
                currentPaused.current = isPaused;
                if (requestedDisplayId.current)
                  displaySwitchResumed.current = !isPaused;
                setPaused(isPaused);
                setPauseReason(message.reason || "");
                acceptSession(message.session);
                if (isPaused) {
                  disableControl();
                  clearFrame();
                }
              } else if (
                message.type === "displays" &&
                Array.isArray(message.displays)
              ) {
                const valid = message.displays.filter(
                  (item) =>
                    item &&
                    typeof item.id === "string" &&
                    item.id.length > 0 &&
                    item.id.length <= 256 &&
                    typeof item.name === "string" &&
                    Number.isInteger(item.width) &&
                    Number.isInteger(item.height) &&
                    item.width > 0 &&
                    item.height > 0 &&
                    item.width <= 16384 &&
                    item.height <= 16384,
                );
                const known = [
                  ...new Map(valid.map((item) => [item.id, item])).values(),
                ];
                setDisplays(known);
                setSelectedDisplayId((previous) =>
                  known.some((item) => item.id === previous)
                    ? previous
                    : known.find((item) => item.isPrimary)?.id ||
                      known[0]?.id ||
                      "",
                );
                if (
                  requestedDisplayId.current &&
                  !known.some((item) => item.id === requestedDisplayId.current)
                ) {
                  requestedDisplayId.current = null;
                  setSwitchingDisplay(false);
                  disableControl();
                  clearFrame();
                  setError(
                    "The selected monitor is no longer available. Choose an available monitor to start a new display switch.",
                  );
                }
              } else if (message.type === "capabilities") {
                setSecureAttentionAvailable(message.secureAttention === true);
              } else if (
                message.type === "secureAttentionResult" &&
                message.requestId === secureAttentionRequest.current &&
                typeof message.success === "boolean"
              ) {
                if (secureAttentionTimer.current !== null)
                  window.clearTimeout(secureAttentionTimer.current);
                secureAttentionTimer.current = null;
                secureAttentionRequest.current = null;
                setSecureAttentionPending(false);
                setSecureAttentionFeedback({
                  success: message.success,
                  message:
                    typeof message.message === "string"
                      ? message.message.slice(0, 500)
                      : message.success
                        ? "The endpoint accepted the Windows security request."
                        : "The Windows security request was not accepted.",
                });
              } else if (
                message.type === "display" &&
                Number.isInteger(message.width) &&
                Number.isInteger(message.height) &&
                message.width > 0 &&
                message.height > 0 &&
                message.width <= 16384 &&
                message.height <= 16384
              ) {
                if (
                  requestedDisplayId.current &&
                  message.id !== requestedDisplayId.current
                )
                  return;
                if (typeof message.id === "string" && message.id) {
                  activeDisplayId.current = message.id;
                  setSelectedDisplayId(message.id);
                  if (message.id === requestedDisplayId.current)
                    displaySwitchConfirmed.current = true;
                }
                setDisplay({ width: message.width, height: message.height });
              }
            } catch {
              /* Ignore malformed state instead of granting any input capability. */
            }
            return;
          }
          if (
            !(event.data instanceof Blob) ||
            event.data.size > 8 * 1024 * 1024 ||
            currentSession.current?.status !== "active" ||
            currentPaused.current ||
            stopped.current ||
            (requestedDisplayId.current &&
              (!displaySwitchConfirmed.current ||
                !displaySwitchResumed.current))
          )
            return;
          const sequence = ++frameSequence.current;
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(event.data);
            if (
              disposed.current ||
              sequence !== frameSequence.current ||
              currentSession.current?.status !== "active" ||
              currentPaused.current ||
              stopped.current ||
              (requestedDisplayId.current &&
                (!displaySwitchConfirmed.current ||
                  !displaySwitchResumed.current)) ||
              !canvas.current
            )
              return;
            // Canvas drawing avoids blob image URLs and retains only the current frame.
            if (
              bitmap.width <= 0 ||
              bitmap.height <= 0 ||
              bitmap.width > 16384 ||
              bitmap.height > 16384
            )
              return;
            const surface = canvas.current;
            if (
              surface.width !== bitmap.width ||
              surface.height !== bitmap.height
            ) {
              surface.width = bitmap.width;
              surface.height = bitmap.height;
              const dimensions = { width: bitmap.width, height: bitmap.height };
              setDisplay((previous) =>
                previous.width > 0 ? previous : dimensions,
              );
            }
            surface.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
            lastFrame.current = Date.now();
            framePresent.current = true;
            setFrameAt(lastFrame.current);
            setStale(false);
            setHasFrame(true);
            if (requestedDisplayId.current) {
              requestedDisplayId.current = null;
              setSwitchingDisplay(false);
            }
          } catch {
            /* A failed JPEG decode never shows an old frame as a new one. */
          } finally {
            bitmap?.close();
          }
        };
        ws.onerror = () => {
          if (!disposed.current)
            setError(
              "The secure desktop stream could not connect. End this session and start a new one from the workspace.",
            );
        };
        ws.onclose = () => {
          connectedRef.current = false;
          if (disposed.current) return;
          setConnected(false);
          setConnecting(false);
          requestedDisplayId.current = null;
          setSwitchingDisplay(false);
          setSecureAttentionAvailable(false);
          setSecureAttentionPending(false);
          if (secureAttentionRequest.current)
            setSecureAttentionFeedback({
              success: false,
              message:
                "The connection closed before the Windows security request was confirmed. It will not be retried.",
            });
          secureAttentionRequest.current = null;
          if (secureAttentionTimer.current !== null)
            window.clearTimeout(secureAttentionTimer.current);
          disableControl();
          clearFrame();
          if (!terminal(currentSession.current?.status) && !stopped.current)
            setError(
              "The support connection closed. Control is released; this window will not reconnect automatically.",
            );
          // A relay that refuses an already-ended session closes before any state arrives.
          // Once the server confirms the end, its reason replaces the generic banner.
          void readState().then(() => {
            if (!disposed.current && terminal(currentSession.current?.status))
              setError("");
          });
        };
        statePoll = window.setInterval(() => void readState(), 5000);
      } catch (err) {
        if (!disposed.current) {
          setError((err as Error).message);
          setConnecting(false);
        }
      }
    };
    const visibility = () => {
      if (document.hidden) disableControl();
    };
    const blur = () => disableControl();
    const closing = () => {
      releaseAll();
      const current = currentSession.current;
      if (current && !terminal(current.status)) {
        // Best effort only; WebSocket closure also tells the relay this operator left.
        void fetch(`/api/support/sessions/${current.id}/stop`, {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf.current,
          },
          body: "{}",
        }).catch(() => {});
      }
      socket.current?.close(1000, "Operator left the support window");
    };
    const timer = window.setInterval(() => {
      setNow(Date.now());
      const current = currentSession.current;
      if (
        current &&
        !terminal(current.status) &&
        Date.now() >= Date.parse(current.expiresAt)
      ) {
        acceptSession({ ...current, status: "expired" });
      }
      if (
        lastFrame.current &&
        Date.now() - lastFrame.current > 10000 &&
        framePresent.current
      ) {
        setStale(true);
        disableControl();
        clearFrame();
      }
    }, 1000);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", closing);
    void start();
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
      if (statePoll !== undefined) window.clearInterval(statePoll);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", closing);
      releaseAll();
      socket.current?.close(1000, "Support viewer closed");
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
      if (secureAttentionTimer.current !== null)
        window.clearTimeout(secureAttentionTimer.current);
    };
  }, []);

  const ready =
    !!session &&
    session.status === "active" &&
    connected &&
    hasFrame &&
    !stale &&
    !paused &&
    !localStopped &&
    !stopping &&
    !switchingDisplay;
  const approved = ready && session.controlApproved;
  const canSelectDisplay =
    session?.status === "active" &&
    connected &&
    !paused &&
    !localStopped &&
    !stopping &&
    !switchingDisplay &&
    displays.length > 1;
  const selectDisplay = (displayId: string) => {
    if (
      !canSelectDisplay ||
      requestedDisplayId.current ||
      !displays.some((item) => item.id === displayId) ||
      displayId === activeDisplayId.current ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return;
    disableControl();
    clearFrame();
    requestedDisplayId.current = displayId;
    displaySwitchConfirmed.current = false;
    displaySwitchResumed.current = false;
    currentPaused.current = true;
    setPaused(true);
    setPauseReason(
      "Switching monitor. Waiting for the selected display and a fresh frame.",
    );
    setSwitchingDisplay(true);
    setSelectedDisplayId(displayId);
    setDisplay({ width: 0, height: 0 });
    setStale(false);
    lastFrame.current = 0;
    setFrameAt(0);
    // View-only sessions can select a monitor; this never grants input permission.
    socket.current.send(JSON.stringify({ type: "selectDisplay", displayId }));
  };
  const canSecureAttention =
    approved &&
    controlEnabled &&
    secureAttentionAvailable &&
    !secureAttentionPending;
  const sendSecureAttention = () => {
    if (
      !canSecureAttention ||
      secureAttentionRequest.current !== null ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return;
    releaseAll();
    const requestId = crypto.randomUUID();
    secureAttentionRequest.current = requestId;
    setSecureAttentionPending(true);
    setSecureAttentionFeedback(null);
    // This invokes the Windows service's native SAS path; never fake the key sequence.
    socket.current.send(JSON.stringify({ type: "secureAttention", requestId }));
    secureAttentionTimer.current = window.setTimeout(() => {
      if (secureAttentionRequest.current !== requestId) return;
      secureAttentionRequest.current = null;
      setSecureAttentionPending(false);
      setSecureAttentionFeedback({
        success: false,
        message:
          "The Windows security request was not confirmed. It will not be retried automatically.",
      });
    }, 30000);
  };
  canInput.current = approved && controlEnabled && focused;
  control.current = controlEnabled;
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canInput.current || !event.isPrimary) return;
    pendingMove.current = point(event);
    if (moveTimer.current !== null) return;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = null;
      if (canInput.current && pendingMove.current)
        send({ type: "input", action: "move", ...pendingMove.current });
      pendingMove.current = null;
    }, 33);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (
      !approved ||
      !control.current ||
      !event.isPrimary ||
      ![0, 1, 2].includes(event.button)
    )
      return;
    event.preventDefault();
    canvas.current?.focus();
    setFocused(true);
    canInput.current = true;
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = null;
    pendingMove.current = null;
    const position = point(event);
    if (!position) return;
    canvas.current?.setPointerCapture(event.pointerId);
    pressedButtons.current.add(event.button);
    send({
      type: "input",
      action: "down",
      ...position,
      button: event.button as 0 | 1 | 2,
    });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pressedButtons.current.has(event.button)) return;
    event.preventDefault();
    const position = point(event);
    send({
      type: "input",
      action: "up",
      ...(position || {}),
      button: event.button as 0 | 1 | 2,
    });
    pressedButtons.current.delete(event.button);
    if (canvas.current?.hasPointerCapture(event.pointerId))
      canvas.current.releasePointerCapture(event.pointerId);
  };
  const key = (event: ReactKeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    // Escape returns focus/control to the operator toolbar and is never trapped remotely.
    if (event.code === "Escape") {
      event.preventDefault();
      disableControl();
      return;
    }
    if (
      !canInput.current ||
      !allowedKey(event.code) ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (down) {
      if (event.repeat && !pressedKeys.current.has(event.code)) return;
      pressedKeys.current.add(event.code);
      send({ type: "input", action: "keyDown", key: event.code });
    } else if (pressedKeys.current.delete(event.code))
      send({ type: "input", action: "keyUp", key: event.code });
  };
  // A non-passive listener is required to keep remote wheel events from scrolling this page.
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      if (!canInput.current) return;
      event.preventDefault();
      const position = point(event);
      if (!position) return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? surface.clientHeight
            : 1);
      send({
        type: "input",
        action: "wheel",
        ...position,
        deltaY: Math.min(1200, Math.max(-1200, Math.round(delta))),
      });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, []);
  const stop = async () => {
    if (!session || stopping) return;
    stopped.current = true;
    setLocalStopped(true);
    setStopping(true);
    disableControl();
    clearFrame();
    try {
      const result = await request<SupportSession>(
        `/support/sessions/${session.id}/stop`,
        "POST",
        {},
      );
      acceptSession(result);
      setError("");
    } catch (err) {
      setError(
        `The desktop is hidden and your input is released. The server could not confirm the stop: ${(err as Error).message}`,
      );
    } finally {
      socket.current?.close(1000, "Operator stopped support");
      setStopping(false);
    }
  };

  const remaining = session
    ? Math.max(
        0,
        Math.ceil((new Date(session.expiresAt).getTime() - now) / 1000),
      )
    : 0;
  // These values are snapshotted by the server when the session is created.
  const approvalRequired = session?.approvalRequired !== false;
  const approvalSeconds = session?.approvalSeconds ?? 15;
  const showSessionDetails = session?.showSessionDetails !== false;
  const statusText = localStopped
    ? "Session ended"
    : session?.status === "active"
      ? switchingDisplay
        ? "Switching monitor"
        : !connected
          ? connecting
            ? "Connecting relay"
            : "Connection closed"
          : paused
            ? "Desktop paused"
            : stale
              ? "Waiting for desktop"
              : "Connected"
      : session?.status === "awaiting_consent"
        ? approvalRequired
          ? "Waiting for staff response"
          : "Starting visible session"
        : session?.status === "requested"
          ? "Contacting endpoint"
          : session?.status === "declined"
            ? "Staff declined the request"
            : session?.status === "expired"
              ? "Session expired"
              : session?.status === "failed"
                ? "Session unavailable"
                : session?.status === "stopped"
                  ? "Session ended"
                  : connecting
                    ? "Opening secure session"
                    : "Unable to open session";
  const initialWait =
    connecting ||
    switchingDisplay ||
    ["requested", "awaiting_consent"].includes(session?.status || "");
  const ended = terminal(session?.status) || localStopped;
  const endReason = terminal(session?.status) ? supportEndReason(session) : "";
  // Set by the agent's SYSTEM helper when nobody was signed in to the computer.
  const signInScreen = session?.consentUser === "Windows sign-in screen";
  const showOverlay = !hasFrame || paused || stale || ended || switchingDisplay;
  const overlayTitle = ended
    ? statusText
    : switchingDisplay
      ? "Switching to the selected monitor"
      : paused
        ? "The staff desktop is paused"
        : stale
          ? "The live desktop has stopped updating"
          : session?.status === "active" && connected
            ? "Waiting for the first desktop frame"
            : statusText;

  return (
    <div className="rs-app">
      <header className="rs-header">
        <a className="rs-brand" href="/" target="_blank" rel="noreferrer">
          <span>
            <BookOpen size={21} />
          </span>
          <strong>
            library<span>.</span>
          </strong>
          <small>REMOTE SUPPORT</small>
        </a>
        <div className="rs-header-center">
          <Monitor size={17} />
          <strong>{session?.endpointName || "Endpoint support"}</strong>
          <span
            className={`rs-status ${ready ? "rs-status-live" : ended ? "rs-status-ended" : ""}`}
          >
            <i />
            {statusText}
          </span>
        </div>
        <div className="rs-header-actions">
          {session && !ended && (
            <span className="rs-timer" title="Maximum remaining session time">
              {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")} remaining
            </span>
          )}
          <button
            className="rs-stop"
            disabled={!session || ended || stopping}
            onClick={() => void stop()}
          >
            {stopping ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Power size={15} />
            )}
            End session
          </button>
        </div>
      </header>
      <section className="rs-consent-bar">
        <ShieldCheck size={16} />
        <span>
          {ended
            ? "This session is closed. No desktop is displayed and remote input is disabled."
            : session?.status === "active"
              ? signInScreen
                ? showSessionDetails || approvalRequired
                  ? "Showing the Windows sign-in screen without a notice or banner. The session ends when someone signs in. Ctrl+Alt+Shift+F12 ends it locally."
                  : "Showing the Windows sign-in screen without a notice or banner; it continues if someone signs in. Ctrl+Alt+Shift+F12 ends it locally."
                : showSessionDetails
                ? "The staff computer keeps a visible sharing indicator. Ctrl+Alt+Shift+F12 ends sharing locally."
                : "No staff banner or icon is shown for this session. Ctrl+Alt+Shift+F12 still ends sharing locally."
              : !session
                ? "Opening your session and loading its access policy."
                : approvalRequired
                  ? `The staff member sees an approve/deny notice. Sharing starts after ${approvalSeconds} second${approvalSeconds === 1 ? "" : "s"} if no response; no desktop is shown before that.`
                  : showSessionDetails
                    ? "Approval notice is disabled by an administrator. The session connects immediately with a visible staff indicator and local emergency shortcut."
                    : "Sessions start without a notice, banner, or icon. Ctrl+Alt+Shift+F12 still ends sharing locally."}
        </span>
        <strong>
          {session?.operatorName || userName || "Authorized operator"}
        </strong>
      </section>
      {error && (
        <div className="rs-error" role="alert">
          <XCircle size={16} />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <div className="rs-toolbar">
        <div className="rs-toolbar-group">
          <button
            type="button"
            className={`rs-control-toggle ${controlEnabled ? "rs-control-on" : ""}`}
            disabled={!approved}
            onClick={() => {
              if (controlEnabled) disableControl();
              else {
                setControlEnabled(true);
                control.current = true;
                canvas.current?.focus();
                setFocused(true);
              }
            }}
          >
            <MousePointer2 size={15} />
            {controlEnabled ? "Control enabled" : "Enable control"}
          </button>
          <button
            type="button"
            className="rs-sas-button"
            disabled={!canSecureAttention}
            onClick={sendSecureAttention}
            aria-describedby="rs-security-limits"
            title={
              !secureAttentionAvailable
                ? "Native Ctrl+Alt+Delete is unavailable on this endpoint."
                : !controlEnabled
                  ? "Enable remote control to request Ctrl+Alt+Delete."
                  : signInScreen
                    ? "Send Ctrl+Alt+Delete to the computer's Windows sign-in screen."
                    : "Request the Windows security screen. Viewing and control pause on protected desktops."
            }
          >
            {secureAttentionPending ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <LockKeyhole size={14} />
            )}
            Ctrl+Alt+Delete
          </button>
          <span className="rs-mode-label">
            {ended
              ? "Control unavailable · session ended"
              : switchingDisplay
                ? "Control unavailable · switching monitor"
                : paused
                  ? "Control unavailable · desktop paused"
                  : !connected
                    ? "Control unavailable · relay disconnected"
                    : !session?.controlApproved
                      ? "View only · control unavailable"
                      : controlEnabled
                        ? focused
                          ? "Mouse and keyboard go to the staff computer"
                          : "Click the desktop to send input"
                        : "Control available · enable when ready"}
          </span>
        </div>
        <div className="rs-toolbar-group">
          <label className="rs-scale rs-monitor-select">
            <span>Monitor</span>
            <select
              aria-label="Monitor"
              disabled={!canSelectDisplay}
              value={selectedDisplayId}
              onChange={(event) => selectDisplay(event.target.value)}
            >
              {displays.length ? (
                displays.map((item, index) => (
                  <option
                    key={item.id}
                    value={item.id}
                  >{`Monitor ${index + 1} · ${item.name}${item.isPrimary ? " (Primary)" : ""} · ${item.width} × ${item.height}`}</option>
                ))
              ) : (
                <option value="">Primary display</option>
              )}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="rs-scale">
            <Monitor size={14} />
            <select
              aria-label="Desktop zoom"
              value={scale}
              onChange={(event) =>
                setScale(event.target.value as "fit" | "actual")
              }
            >
              <option value="fit">Fit to window</option>
              <option value="actual">Actual size</option>
            </select>
            <ChevronDown size={12} />
          </label>
          <button
            type="button"
            className="rs-tool-button"
            onClick={() => {
              if (!document.fullscreenElement)
                void stage.current
                  ?.requestFullscreen()
                  .catch(() =>
                    setError("Your browser did not allow full screen."),
                  );
              else void document.exitFullscreen();
            }}
            title="Toggle full screen"
            aria-label="Toggle full screen"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
      <div className="rs-security-note" id="rs-security-limits">
        <LockKeyhole size={13} />
        <span>
          {signInScreen
            ? "Nobody was signed in (or the computer was locked), so this session shows the Windows sign-in screen. Viewing and control continue on the sign-in, lock and Ctrl+Alt+Delete screens. Windows policy must allow service-generated Ctrl+Alt+Delete; this app does not change it."
            : "Ctrl+Alt+Delete requests the Windows security screen. Viewing and control pause there until someone returns to the regular desktop. Windows policy must allow service-generated secure attention; this app does not change it."}
        </span>
      </div>
      {secureAttentionFeedback && (
        <div
          className={`rs-sas-feedback ${secureAttentionFeedback.success ? "rs-sas-success" : ""}`}
          role={secureAttentionFeedback.success ? "status" : "alert"}
        >
          {secureAttentionFeedback.success ? (
            <CheckCircle2 size={15} />
          ) : (
            <XCircle size={15} />
          )}
          <span>
            {secureAttentionFeedback.message}
            {secureAttentionFeedback.success &&
              " Confirmation covers the request, not viewing or controlling a protected Windows screen."}
          </span>
          <button
            type="button"
            onClick={() => setSecureAttentionFeedback(null)}
            aria-label="Dismiss Windows security request result"
          >
            ×
          </button>
        </div>
      )}
      <div
        className={`rs-stage ${scale === "actual" ? "rs-actual" : "rs-fit"} ${controlEnabled ? "rs-stage-control" : ""}`}
        ref={stage}
      >
        <canvas
          ref={canvas}
          className={`rs-desktop ${hasFrame && !showOverlay ? "rs-frame-visible" : ""}`}
          width={1}
          height={1}
          tabIndex={ready ? 0 : -1}
          aria-label={`Live staff desktop${controlEnabled ? ". Remote control enabled. Press Escape to release control." : ". Viewing only."}`}
          onPointerMove={move}
          onPointerDown={pointerDown}
          onPointerUp={pointerUp}
          onPointerCancel={() => releaseAll()}
          onLostPointerCapture={() => {
            if (pressedButtons.current.size) releaseAll();
          }}
          onContextMenu={(event) => {
            if (controlEnabled) event.preventDefault();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            releaseAll();
            setFocused(false);
          }}
          onKeyDown={(event) => key(event, true)}
          onKeyUp={(event) => key(event, false)}
        />
        {showOverlay && (
          <div className="rs-placeholder" role="status">
            <span className="rs-placeholder-icon">
              {initialWait && !error ? (
                <Loader2 size={33} className="spin" />
              ) : paused ? (
                <LockKeyhole size={33} />
              ) : ended ? (
                <CheckCircle2 size={33} />
              ) : !connected && !connecting ? (
                <WifiOff size={33} />
              ) : (
                <Monitor size={33} />
              )}
            </span>
            <span className="rs-eyebrow">REMOTE SUPPORT SESSION</span>
            <h1>{overlayTitle}</h1>
            <p>
              {ended
                ? `${endReason ? endReason + " " : ""}The desktop is hidden and remote input is disabled. Start a new session from the endpoint if more help is needed.`
                : switchingDisplay
                  ? "The previous image is cleared and remote input is released. Viewing resumes only after the selected monitor is confirmed and sends a fresh frame. Enable control again when you are ready."
                  : paused
                    ? pauseReason ||
                      "The computer may be locked, showing a protected Windows prompt, or temporarily unavailable. Remote input is disabled."
                    : stale
                      ? "The last frame is hidden so an old screen cannot be mistaken for the current desktop. Control is released until live frames return."
                      : session?.status === "awaiting_consent"
                        ? approvalRequired
                          ? `The staff member can approve or deny the visible request. If they do not respond, support starts after ${approvalSeconds} second${approvalSeconds === 1 ? "" : "s"}. Ctrl+Alt+Shift+F12 ends sharing locally.`
                          : showSessionDetails
                            ? "Approval notice is disabled by an administrator. The support companion is starting with a visible sharing indicator; Ctrl+Alt+Shift+F12 ends sharing locally."
                            : "The administrator disabled the notice, banner, and icon. The session is starting; Ctrl+Alt+Shift+F12 still ends sharing locally."
                        : session?.status === "requested"
                          ? approvalRequired
                            ? "The endpoint will open a visible request in the staff member’s signed-in Windows session. No screen is shared yet."
                            : showSessionDetails
                              ? "Approval notice is disabled by an administrator. The endpoint will connect immediately with a visible sharing indicator in its signed-in Windows session."
                              : "Sessions start without a notice, banner, or icon. Ctrl+Alt+Shift+F12 still ends sharing locally."
                          : session?.status === "active"
                            ? "The support companion is connected. The live desktop will appear as soon as it sends a frame."
                            : "This window connects only to the selected endpoint using its session access policy."}
            </p>
            {ended && (
              <a
                className="rs-return"
                href="/"
                target="_blank"
                rel="noreferrer"
              >
                <ArrowLeft size={15} />
                Return to workspace
              </a>
            )}
            <div className="rs-placeholder-guardrails">
              <span>
                <ShieldCheck size={14} />
                {!session
                  ? "Workspace access policy"
                  : approvalRequired
                    ? `${approvalSeconds}-second staff notice`
                    : "Approval notice disabled"}
              </span>
              <span>
                <MousePointer2 size={14} />
                Visible cursor
              </span>
              <span>
                <Power size={14} />
                Emergency stop hotkey
              </span>
            </div>
          </div>
        )}
        {controlEnabled && ready && (
          <div className="rs-control-hint">
            <Keyboard size={13} />
            Remote control on <span>·</span> Press <kbd>Esc</kbd> to release
          </div>
        )}
      </div>
      <footer className="rs-footer">
        <span>
          <span
            className={`rs-connection-dot ${connected && !ended ? "rs-connected" : ""}`}
          />
          {connected && !ended
            ? "Secure relay connected"
            : "Relay disconnected"}
          {display.width > 0 && (
            <small>
              {display.width} × {display.height}
            </small>
          )}
        </span>
        <span>
          {hasFrame && frameAt ? (
            <>
              <Signal size={12} />
              Last frame {Math.max(0, Math.floor((now - frameAt) / 1000))}s ago
            </>
          ) : (
            <>
              <ShieldCheck size={12} />
              No desktop is displayed
            </>
          )}
        </span>
        <span className="rs-footer-limit">
          {signInScreen
            ? "No clipboard or file transfer"
            : "No clipboard or file transfer · Protected Windows prompts cannot be controlled"}
        </span>
      </footer>
    </div>
  );
}
