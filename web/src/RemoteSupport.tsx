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
  CircleHelp,
  Ellipsis,
  Keyboard,
  KeyboardOff,
  Loader2,
  LockKeyhole,
  Maximize2,
  Monitor,
  MousePointer2,
  Pointer,
  Power,
  RotateCw,
  ShieldCheck,
  Shrink,
  Signal,
  Touchpad,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import "./RemoteSupport.css";
import "./RemoteSupportTouch.css";
import { supportEndReason } from "./supportEndReason";
import { parseSupportFrame } from "./supportFrames";
import {
  KEYBOARD_SENTINEL,
  diffText,
  keyToMessages,
  strokesToMessages,
  textToStrokes,
  type KeyEventMessage,
  type KeyStroke,
  type Modifier,
} from "./supportKeyboard";
import { TouchGestures, type GestureAction, type TouchMode } from "./supportTouch";

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
  | {
      type: "capabilities";
      secureAttention: boolean;
      secureDesktop: boolean;
      deltaFrames?: boolean;
    }
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

// Touch screens, and windows too narrow or short for the desktop toolbar (phones in landscape are about 375px tall).
const touchLayoutQuery = "(pointer: coarse), (max-width: 760px), (max-height: 480px)";
const media = (query: string) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
// Per-viewer conveniences only; the page works the same when storage is blocked.
const readPreference = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePreference = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Private windows can refuse storage. */
  }
};
const modifierKeys: { code: Modifier; label: string }[] = [
  { code: "ControlLeft", label: "Ctrl" },
  { code: "AltLeft", label: "Alt" },
  { code: "ShiftLeft", label: "Shift" },
  { code: "MetaLeft", label: "Win" },
];
const navigationKeys: { code: string; label: string; wide?: boolean }[] = [
  { code: "Escape", label: "Esc" },
  { code: "Tab", label: "Tab" },
  { code: "ArrowLeft", label: "←" },
  { code: "ArrowUp", label: "↑" },
  { code: "ArrowDown", label: "↓" },
  { code: "ArrowRight", label: "→" },
  { code: "Home", label: "Home" },
  { code: "End", label: "End" },
  { code: "PageUp", label: "PgUp" },
  { code: "PageDown", label: "PgDn" },
  { code: "Delete", label: "Del" },
  { code: "Backspace", label: "⌫" },
  { code: "Enter", label: "Enter", wide: true },
];
const functionKeys = Array.from({ length: 12 }, (_, index) => ({
  code: `F${index + 1}`,
  label: `F${index + 1}`,
}));

/**
 * Call directly from a user click so browsers permit the dedicated support window. Phones and tablets (and the
 * installed home-screen app, which cannot share its sign-in with a separate browser window) open it in this tab.
 */
export function openRemoteSupport(endpointId: string): Window | null {
  const url = `/support/new?endpointId=${encodeURIComponent(endpointId)}`;
  if (media("(pointer: coarse)") || media("(display-mode: standalone)")) {
    window.location.assign(url);
    return window;
  }
  const popup = window.open(
    url,
    "_blank",
    "popup,width=1360,height=900,resizable=yes,scrollbars=yes",
  );
  if (popup) {
    popup.opener = null;
    return popup;
  }
  window.location.assign(url);
  return window;
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
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectStarted = useRef(false);
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

  const frameQueue = useRef<Promise<void>>(Promise.resolve()),
    needKeyframe = useRef(true),
    lastRefresh = useRef(0),
    lastFrameState = useRef(0),
    framesDrawn = useRef(0);
  const [fps, setFps] = useState(0),
    [secureDesktop, setSecureDesktop] = useState(false);

  // Phones and tablets: gestures, on-screen keyboard, local zoom.
  const [touchLayout, setTouchLayout] = useState(() => media(touchLayoutQuery));
  const [touchMode, setTouchModeState] = useState<TouchMode>(() =>
    readPreference("rs-touch-mode") === "direct" ? "direct" : "trackpad",
  );
  const [keyboardOpen, setKeyboardOpen] = useState(false),
    [modifiers, setModifiers] = useState<Modifier[]>([]),
    [showFunctionKeys, setShowFunctionKeys] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [typingNote, setTypingNote] = useState(""),
    [zoomScale, setZoomScale] = useState(1),
    [viewport, setViewport] = useState<{ height: number; top: number } | null>(
      null,
    );
  const ime = useRef<HTMLTextAreaElement>(null),
    imeValue = useRef(KEYBOARD_SENTINEL),
    composing = useRef(false),
    modifiersRef = useRef<Modifier[]>([]),
    keyQueue = useRef<KeyEventMessage[]>([]),
    keyTimer = useRef<number | null>(null),
    typingNoteTimer = useRef<number | null>(null),
    zoom = useRef({ scale: 1, x: 0, y: 0 }),
    cursorDot = useRef<HTMLDivElement>(null),
    holdRing = useRef<HTMLDivElement>(null),
    gestures = useRef<TouchGestures | null>(null),
    touchModeRef = useRef(touchMode);
  touchModeRef.current = touchMode;

  const sendControl = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message));
  };
  // Asks the endpoint to repaint the whole screen (after a pause, a stale picture or a lost patch).
  const requestRefresh = () => {
    if (Date.now() - lastRefresh.current < 1000) return;
    lastRefresh.current = Date.now();
    sendControl({ type: "refresh" });
  };
  const viewable = () =>
    !disposed.current &&
    !stopped.current &&
    currentSession.current?.status === "active" &&
    !currentPaused.current &&
    !(
      requestedDisplayId.current &&
      (!displaySwitchConfirmed.current || !displaySwitchResumed.current)
    );
  const frameShown = (width: number, height: number) => {
    lastFrame.current = Date.now();
    framePresent.current = true;
    // The footer only needs about-right timing; avoid re-rendering on every frame.
    if (lastFrame.current - lastFrameState.current > 500) {
      lastFrameState.current = lastFrame.current;
      setFrameAt(lastFrame.current);
    }
    setStale(false);
    setHasFrame(true);
    setDisplay((previous) =>
      previous.width > 0 ? previous : { width, height },
    );
    if (requestedDisplayId.current) {
      requestedDisplayId.current = null;
      setSwitchingDisplay(false);
    }
  };
  const drawFrame = async (data: ArrayBuffer) => {
    const frame = parseSupportFrame(data);
    if (!frame) return;
    // Acknowledge every frame, drawn or not: the endpoint sends the next one only after this,
    // so the picture never falls behind a queue on a slow connection.
    if (frame.kind === "delta") sendControl({ type: "frameAck", seq: frame.seq });
    const surface = canvas.current;
    if (!viewable() || !surface) {
      needKeyframe.current = true;
      return;
    }
    const sequence = frameSequence.current;
    if (frame.kind === "jpeg") {
      // Agents before 0.1.11 send one whole JPEG per frame.
      const bitmap = await createImageBitmap(
        new Blob([data], { type: "image/jpeg" }),
      );
      try {
        if (
          sequence !== frameSequence.current ||
          !viewable() ||
          bitmap.width <= 0 ||
          bitmap.height <= 0 ||
          bitmap.width > 16384 ||
          bitmap.height > 16384
        )
          return;
        if (surface.width !== bitmap.width || surface.height !== bitmap.height) {
          surface.width = bitmap.width;
          surface.height = bitmap.height;
        }
        surface.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      framesDrawn.current++;
      frameShown(surface.width, surface.height);
      return;
    }
    if (
      !frame.keyframe &&
      (needKeyframe.current ||
        surface.width !== frame.width ||
        surface.height !== frame.height)
    ) {
      // A patch without the picture under it would show a mix of old and new screens.
      requestRefresh();
      return;
    }
    const bitmaps = await Promise.all(
      frame.rects.map((rect) =>
        createImageBitmap(
          new Blob([data.slice(rect.start, rect.end)], { type: "image/jpeg" }),
        ),
      ),
    );
    try {
      if (sequence !== frameSequence.current || !viewable()) {
        needKeyframe.current = true;
        return;
      }
      if (
        frame.keyframe &&
        (surface.width !== frame.width || surface.height !== frame.height)
      ) {
        surface.width = frame.width;
        surface.height = frame.height;
      }
      const context = surface.getContext("2d", { alpha: false });
      if (!context) return;
      frame.rects.forEach((rect, index) =>
        context.drawImage(bitmaps[index], rect.x, rect.y, rect.width, rect.height),
      );
      if (frame.keyframe) needKeyframe.current = false;
      if (frame.rects.length) framesDrawn.current++;
      frameShown(frame.width, frame.height);
    } finally {
      bitmaps.forEach((bitmap) => bitmap.close());
    }
  };

  const clearFrame = () => {
    // Clear sensitive pixels promptly on pause, session withdrawal, stop or disconnect.
    needKeyframe.current = true;
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
    // Typed text still waiting to be paced out is dropped, never sent after control ends.
    keyQueue.current = [];
    if (keyTimer.current !== null) window.clearTimeout(keyTimer.current);
    keyTimer.current = null;
    gestures.current?.cancel();
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
    modifiersRef.current = [];
    setModifiers([]);
    if (document.activeElement === ime.current) ime.current?.blur();
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
        ws.binaryType = "arraybuffer";
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
                setSecureDesktop(message.secureDesktop === true);
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
            !(event.data instanceof ArrayBuffer) ||
            event.data.byteLength > 8 * 1024 * 1024
          )
            return;
          // Frames decode strictly in order: a patch must land on the picture it was made against.
          const data = event.data;
          frameQueue.current = frameQueue.current
            .then(() => drawFrame(data))
            .catch(() => {
              /* A failed decode never shows an old frame as a new one. */
              needKeyframe.current = true;
            });
        };
        ws.onerror = () => {
          if (!disposed.current)
            setError(
              "The secure desktop stream could not connect. Use Reconnect to start a new session.",
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
              "The support connection closed. Control is released. Use Reconnect to start a new session.",
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
      setFps(framesDrawn.current);
      framesDrawn.current = 0;
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
        requestRefresh();
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
    if (!canInput.current || !event.isPrimary || event.pointerType === "touch") return;
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
      event.pointerType === "touch" ||
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
    if (event.pointerType === "touch" || !pressedButtons.current.has(event.button)) return;
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

  // ----- Phones and tablets -------------------------------------------------------------------------------------
  // Remote keys are paced (about 200 events a second) so pasted or swiped text stays under the endpoint's
  // input limit instead of being dropped there.
  const pumpKeys = () => {
    keyTimer.current = null;
    if (!canInput.current) {
      releaseAll();
      return;
    }
    for (let sent = 0; sent < 8 && keyQueue.current.length; sent++) {
      const next = keyQueue.current.shift()!;
      if (!send({ type: "input", action: next.action, key: next.key })) {
        releaseAll();
        return;
      }
      if (next.action === "keyDown") pressedKeys.current.add(next.key);
      else pressedKeys.current.delete(next.key);
    }
    if (keyQueue.current.length) keyTimer.current = window.setTimeout(pumpKeys, 40);
  };
  const queueKeys = (messages: KeyEventMessage[]) => {
    if (!messages.length || !canInput.current) return;
    keyQueue.current.push(...messages);
    if (keyTimer.current === null) pumpKeys();
  };
  const takeModifiers = () => {
    const active = modifiersRef.current;
    if (active.length) {
      modifiersRef.current = [];
      setModifiers([]);
    }
    return active;
  };
  const toggleModifier = (code: Modifier) => {
    const next = modifiersRef.current.includes(code)
      ? modifiersRef.current.filter((item) => item !== code)
      : [...modifiersRef.current, code];
    modifiersRef.current = next;
    setModifiers(next);
  };
  const pressKey = (code: string) => {
    if (!canInput.current) return;
    queueKeys(keyToMessages(code, takeModifiers()));
    navigator.vibrate?.(8);
  };
  const noteTyping = (message: string) => {
    setTypingNote(message);
    if (typingNoteTimer.current !== null) window.clearTimeout(typingNoteTimer.current);
    typingNoteTimer.current = window.setTimeout(() => setTypingNote(""), 4000);
  };
  const resetIme = () => {
    const field = ime.current;
    if (!field || composing.current) return;
    field.value = KEYBOARD_SENTINEL;
    imeValue.current = KEYBOARD_SENTINEL;
    field.setSelectionRange(KEYBOARD_SENTINEL.length, KEYBOARD_SENTINEL.length);
  };
  const imeChanged = () => {
    const field = ime.current;
    if (!field) return;
    const { deletions, insert } = diffText(imeValue.current, field.value);
    imeValue.current = field.value;
    if (canInput.current && (deletions || insert)) {
      const typed = textToStrokes(insert);
      const strokes: KeyStroke[] = [
        ...Array.from({ length: deletions }, () => ({ code: "Backspace", shift: false })),
        ...typed.strokes,
      ];
      queueKeys(strokesToMessages(strokes, takeModifiers()));
      if (typed.skipped)
        noteTyping(
          `${typed.skipped} character${typed.skipped === 1 ? "" : "s"} skipped: only keys on a US keyboard can be typed.`,
        );
    }
    if (
      !composing.current &&
      (field.value.length > 64 ||
        field.value.length < KEYBOARD_SENTINEL.length / 2 ||
        field.value.includes("\n"))
    )
      resetIme();
  };
  const imeKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Hardware keyboards on tablets: shortcuts and keys that do not type text go straight through.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.code === "Escape") {
      event.preventDefault();
      disableControl();
      return;
    }
    if (!canInput.current || !allowedKey(event.code)) return;
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(event.code)) return;
    const held: Modifier[] = [];
    if (event.ctrlKey) held.push("ControlLeft");
    if (event.altKey) held.push("AltLeft");
    if (event.metaKey) held.push("MetaLeft");
    const nonText =
      /^(Arrow|F\d|Home|End|Page|Insert|Delete|Tab|Escape)/.test(event.code);
    if (!held.length && !nonText) return; // Text, Enter and Backspace arrive through the text box.
    event.preventDefault();
    if (event.shiftKey) held.push("ShiftLeft");
    const combined = [...new Set([...held, ...takeModifiers()])];
    queueKeys(keyToMessages(event.code, combined));
  };
  const openKeyboard = () => {
    const field = ime.current;
    if (!field || !canInput.current) return;
    resetIme();
    // Must run inside the tap so phones agree to show their keyboard.
    field.focus({ preventScroll: true });
    setKeyboardOpen(true);
    setFocused(true);
  };
  const closeKeyboard = () => {
    ime.current?.blur();
    setKeyboardOpen(false);
  };

  // Local zoom: the canvas is transformed in place, so pointer mapping (getBoundingClientRect) stays exact.
  const applyZoom = (next: { scale: number; x: number; y: number }) => {
    zoom.current = next;
    const surface = canvas.current;
    if (surface)
      surface.style.transform =
        next.scale === 1 && !next.x && !next.y
          ? ""
          : `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    setZoomScale((previous) =>
      Math.abs(previous - next.scale) > 0.04 || (next.scale === 1) !== (previous === 1)
        ? next.scale
        : previous,
    );
    placeCursor();
  };
  const fitAxis = (low: number, high: number, base: number, size: number, offset: number) =>
    size <= high - low
      ? (low + high) / 2 - base - size / 2
      : Math.min(low - base, Math.max(high - base - size, offset));
  const zoomTo = (
    scale: number,
    originX: number,
    originY: number,
    panX = 0,
    panY = 0,
  ) => {
    const surface = canvas.current,
      area = stage.current;
    if (!surface || !area) return;
    const current = zoom.current;
    const rect = surface.getBoundingClientRect();
    const left = rect.left - current.x,
      top = rect.top - current.y;
    const width = rect.width / current.scale,
      height = rect.height / current.scale;
    const nextScale = Math.min(5, Math.max(1, scale));
    if (nextScale === 1) {
      applyZoom({ scale: 1, x: 0, y: 0 });
      return;
    }
    const factor = nextScale / current.scale;
    const bounds = area.getBoundingClientRect();
    applyZoom({
      scale: nextScale,
      x: fitAxis(
        bounds.left,
        bounds.right,
        left,
        width * nextScale,
        originX - left - factor * (originX - left - current.x) + panX,
      ),
      y: fitAxis(
        bounds.top,
        bounds.bottom,
        top,
        height * nextScale,
        originY - top - factor * (originY - top - current.y) + panY,
      ),
    });
  };
  // Trackpad mode: keep the remote pointer in view while zoomed, like panning a magnifier.
  const followCursor = () => {
    const surface = canvas.current,
      area = stage.current,
      tracker = gestures.current;
    if (!surface || !area || !tracker || zoom.current.scale === 1) return;
    const rect = surface.getBoundingClientRect(),
      bounds = area.getBoundingClientRect();
    const x = rect.left + tracker.cursor.x * rect.width,
      y = rect.top + tracker.cursor.y * rect.height;
    const marginX = bounds.width * 0.15,
      marginY = bounds.height * 0.15;
    const shiftX =
      x < bounds.left + marginX
        ? bounds.left + marginX - x
        : x > bounds.right - marginX
          ? bounds.right - marginX - x
          : 0;
    const shiftY =
      y < bounds.top + marginY
        ? bounds.top + marginY - y
        : y > bounds.bottom - marginY
          ? bounds.bottom - marginY - y
          : 0;
    if (shiftX || shiftY) zoomTo(zoom.current.scale, 0, 0, shiftX, shiftY);
  };
  const placeCursor = () => {
    const dot = cursorDot.current,
      surface = canvas.current,
      area = stage.current,
      tracker = gestures.current;
    if (!dot || !surface || !area || !tracker) return;
    const rect = surface.getBoundingClientRect(),
      bounds = area.getBoundingClientRect();
    dot.style.transform = `translate(${rect.left - bounds.left + tracker.cursor.x * rect.width}px, ${rect.top - bounds.top + tracker.cursor.y * rect.height}px)`;
  };
  const showHold = (clientX: number, clientY: number) => {
    const ring = holdRing.current,
      area = stage.current;
    if (!ring || !area || !control.current) return;
    const bounds = area.getBoundingClientRect();
    ring.style.transform = `translate(${clientX - bounds.left}px, ${clientY - bounds.top}px)`;
    ring.classList.remove("rs-hold-active", "rs-hold-fired");
    void ring.offsetWidth; // restart the fill animation
    ring.classList.add("rs-hold-active");
  };
  const endHold = (fired: boolean) => {
    const ring = holdRing.current;
    if (!ring) return;
    ring.classList.remove("rs-hold-active");
    if (fired) {
      ring.classList.add("rs-hold-fired");
      navigator.vibrate?.(18);
    }
  };
  const gestureAction = (action: GestureAction) => {
    if (action.kind === "zoom") {
      zoomTo(
        zoom.current.scale * action.factor,
        action.originX,
        action.originY,
        action.panX,
        action.panY,
      );
      return;
    }
    if (action.kind === "hold") return showHold(action.clientX, action.clientY);
    if (action.kind === "holdEnd") return endHold(action.fired);
    // Remote input keeps every existing gate: approved, live, unpaused, control enabled.
    if (!canInput.current) {
      if (action.kind === "up" && pressedButtons.current.has(action.button)) releaseAll();
      return;
    }
    if (action.kind === "move") {
      if (touchModeRef.current === "trackpad") {
        placeCursor();
        followCursor();
      }
      pendingMove.current = { x: action.x, y: action.y };
      if (moveTimer.current !== null) return;
      moveTimer.current = window.setTimeout(() => {
        moveTimer.current = null;
        if (canInput.current && pendingMove.current)
          send({ type: "input", action: "move", ...pendingMove.current });
        pendingMove.current = null;
      }, 33);
      return;
    }
    // Clicks and scrolls carry their own position, so a throttled move never lands after them.
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = null;
    pendingMove.current = null;
    if (action.kind === "wheel") {
      send({ type: "input", action: "wheel", x: action.x, y: action.y, deltaY: action.deltaY });
      return;
    }
    if (action.kind === "down") {
      pressedButtons.current.add(action.button);
      send({ type: "input", action: "down", x: action.x, y: action.y, button: action.button });
    } else if (pressedButtons.current.delete(action.button))
      send({ type: "input", action: "up", x: action.x, y: action.y, button: action.button });
  };
  // The recognizer lives for the whole window; it always calls this render's handler.
  const latestGestureAction = useRef(gestureAction);
  latestGestureAction.current = gestureAction;
  if (!gestures.current)
    gestures.current = new TouchGestures(
      (action) => latestGestureAction.current(action),
      () => canvas.current?.getBoundingClientRect() ?? null,
      touchMode,
    );
  const setTouchMode = (mode: TouchMode) => {
    releaseAll();
    setTouchModeState(mode);
    if (gestures.current) gestures.current.mode = mode;
    writePreference("rs-touch-mode", mode);
  };
  const touchPoint = (event: ReactPointerEvent<HTMLElement>) => ({
    id: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    time: event.timeStamp,
  });
  const touchDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || !hasFrame || showOverlay) return;
    event.preventDefault();
    if (approved && control.current) {
      // Keep the phone keyboard open while tapping the desktop; otherwise take focus for input.
      if (document.activeElement !== ime.current) canvas.current?.focus({ preventScroll: true });
      setFocused(true);
      canInput.current = true;
    }
    gestures.current?.down(touchPoint(event));
  };
  const touchMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    gestures.current?.move(touchPoint(event));
  };
  const touchUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    gestures.current?.up(touchPoint(event));
  };
  const touchCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    gestures.current?.cancel();
    gestures.current?.forget(event.pointerId);
    if (pressedButtons.current.size) releaseAll();
  };

  useEffect(() => {
    const query = window.matchMedia?.(touchLayoutQuery);
    if (!query) return;
    const changed = () => setTouchLayout(query.matches);
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  // Keep the whole support window above a phone's on-screen keyboard.
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual || !touchLayout) {
      setViewport(null);
      return;
    }
    const update = () => {
      const keyboardShown = window.innerHeight - visual.height > 80;
      setViewport(keyboardShown ? { height: visual.height, top: visual.offsetTop } : null);
      window.setTimeout(placeCursor, 0);
    };
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, [touchLayout]);
  // iOS Safari zooms the whole page on pinch unless its own gesture events are cancelled.
  useEffect(() => {
    const area = stage.current;
    if (!area) return;
    const block = (event: Event) => event.preventDefault();
    area.addEventListener("gesturestart", block);
    area.addEventListener("gesturechange", block);
    return () => {
      area.removeEventListener("gesturestart", block);
      area.removeEventListener("gesturechange", block);
    };
  }, []);
  const toggleControl = () => {
    if (controlEnabled) {
      disableControl();
      return;
    }
    if (!approved) return;
    setControlEnabled(true);
    control.current = true;
    canvas.current?.focus({ preventScroll: true });
    setFocused(true);
    if (touchLayout && !readPreference("rs-touch-help-seen")) {
      setHelpOpen(true);
      writePreference("rs-touch-help-seen", "1");
    }
  };
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
  const ended = terminal(session?.status) || localStopped;
  const reconnectEndpointId = session?.endpointId || new URLSearchParams(window.location.search).get("endpointId");
  const canReconnect = !!reconnectEndpointId && (ended || (!connecting && !connected));
  const reconnect = () => {
    if (!canReconnect || stopping || reconnectStarted.current) return;
    reconnectStarted.current = true;
    setReconnecting(true);
    disableControl();
    clearFrame();
    // Reuse the normal new-session flow in this window. A full navigation resets
    // all input/frame state and creates fresh authorization, never resuming a consumed launch.
    window.location.replace(
      `/support/new?endpointId=${encodeURIComponent(reconnectEndpointId!)}`,
    );
  };
  const initialWait =
    !canReconnect &&
    (connecting ||
      switchingDisplay ||
      ["requested", "awaiting_consent"].includes(session?.status || ""));
  const endReason = terminal(session?.status) ? supportEndReason(session) : "";
  // Set by the agent's SYSTEM screen helper when nobody was signed in, or the computer was locked, at the start.
  const signInScreen =
    session?.consentUser === "Windows sign-in screen" ||
    session?.consentUser === "Windows lock screen";
  const showOverlay = !hasFrame || paused || stale || ended || switchingDisplay || canReconnect;
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
    <div
      className={`rs-app ${touchLayout ? "rs-touch" : ""} ${keyboardOpen ? "rs-keyboard-open" : ""}`}
      style={
        viewport
          ? { height: viewport.height, minHeight: 0, transform: `translateY(${viewport.top}px)` }
          : undefined
      }
    >
      <header className="rs-header">
        <a
          className="rs-brand"
          href="/"
          target={touchLayout ? undefined : "_blank"}
          rel="noreferrer"
        >
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
                  ? "Showing the Windows sign-in/lock screen. When someone signs in, their desktop appears after the configured notice on it is approved or its countdown ends. Ctrl+Alt+Shift+F12 ends it locally."
                  : "Showing the Windows sign-in/lock screen without a notice or banner; it continues if someone signs in. Ctrl+Alt+Shift+F12 ends it locally."
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
            onClick={toggleControl}
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
                  : secureDesktop
                    ? "Send Ctrl+Alt+Delete. The Windows security, lock or sign-in screen appears here and stays controllable."
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
          {secureDesktop
            ? "Ctrl+Alt+Delete, lock, sign-in and UAC screens are shown and controllable here, so you can sign in or unlock for the user. Windows policy must allow service-generated Ctrl+Alt+Delete; this app does not change it."
            : "Ctrl+Alt+Delete requests the Windows security screen. Viewing and control pause there until someone returns to the regular desktop (update the agent to 0.1.11 to see it). Windows policy must allow service-generated secure attention; this app does not change it."}
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
              !secureDesktop &&
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
        className={`rs-stage ${scale === "actual" ? "rs-actual" : "rs-fit"} ${controlEnabled ? "rs-stage-control" : ""} ${zoomScale > 1 ? "rs-zoomed" : ""}`}
        ref={stage}
        onPointerDown={touchDown}
        onPointerMove={touchMove}
        onPointerUp={touchUp}
        onPointerCancel={touchCancel}
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
          onPointerCancel={(event) => {
            if (event.pointerType !== "touch") releaseAll();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType !== "touch" && pressedButtons.current.size) releaseAll();
          }}
          onContextMenu={(event) => {
            // Phones raise the browser menu on a long press; that press is a right click here instead.
            if (controlEnabled || touchLayout) event.preventDefault();
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
                ? `${endReason ? endReason + " " : ""}The desktop is hidden and remote input is disabled. Use Reconnect to start a new session with this computer.`
                : canReconnect
                  ? "The connection is closed and remote input is disabled. Use Reconnect to start a new session with this computer."
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
            {canReconnect && (
              <button
                type="button"
                className="rs-return rs-reconnect"
                disabled={reconnecting || stopping}
                onClick={reconnect}
              >
                {reconnecting ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <RotateCw size={15} />
                )}
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </button>
            )}
            {ended && (
              <a
                className="rs-return"
                href="/"
                target={touchLayout ? undefined : "_blank"}
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
        <div
          ref={cursorDot}
          className="rs-touch-cursor"
          hidden={!(controlEnabled && ready && touchMode === "trackpad")}
          aria-hidden="true"
        >
          <MousePointer2 size={20} />
        </div>
        <div ref={holdRing} className="rs-hold-ring" aria-hidden="true" />
        {typingNote && (
          <div className="rs-typing-note" role="status">
            {typingNote}
          </div>
        )}
      </div>
      <textarea
        ref={ime}
        className="rs-ime"
        aria-label="Type on the remote computer"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        defaultValue={KEYBOARD_SENTINEL}
        tabIndex={-1}
        onInput={imeChanged}
        onKeyDown={imeKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          imeChanged();
        }}
        onFocus={() => {
          setKeyboardOpen(true);
          setFocused(true);
        }}
        onBlur={() => {
          setKeyboardOpen(false);
          releaseAll();
        }}
      />
      {touchLayout && !ended && (
        <div className="rs-touch-controls">
          {keyboardOpen && controlEnabled && (
            <div className="rs-key-row" role="toolbar" aria-label="Special keys">
              {modifierKeys.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  className={`rs-key rs-key-modifier ${modifiers.includes(item.code) ? "rs-key-on" : ""}`}
                  aria-pressed={modifiers.includes(item.code)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => toggleModifier(item.code)}
                >
                  {item.label}
                </button>
              ))}
              {(showFunctionKeys ? functionKeys : navigationKeys).map((item) => (
                <button
                  key={item.code}
                  type="button"
                  className="rs-key"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => pressKey(item.code)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                className={`rs-key ${showFunctionKeys ? "rs-key-on" : ""}`}
                aria-pressed={showFunctionKeys}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setShowFunctionKeys((value) => !value)}
              >
                Fn
              </button>
            </div>
          )}
          <div className="rs-dock" role="toolbar" aria-label="Touch controls">
            <button
              type="button"
              className={`rs-dock-button rs-dock-control ${controlEnabled ? "rs-dock-on" : ""}`}
              disabled={!approved && !controlEnabled}
              onClick={toggleControl}
            >
              <MousePointer2 size={18} />
              <span>{controlEnabled ? "Control on" : approved ? "Control" : "View only"}</span>
            </button>
            <button
              type="button"
              className={`rs-dock-button ${keyboardOpen ? "rs-dock-on" : ""}`}
              disabled={!controlEnabled || !ready}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (keyboardOpen ? closeKeyboard() : openKeyboard())}
            >
              {keyboardOpen ? <KeyboardOff size={18} /> : <Keyboard size={18} />}
              <span>Keyboard</span>
            </button>
            <button
              type="button"
              className="rs-dock-button"
              onClick={() => setTouchMode(touchMode === "trackpad" ? "direct" : "trackpad")}
              aria-label={`Pointer mode: ${touchMode === "trackpad" ? "trackpad" : "direct touch"}. Tap to switch.`}
            >
              {touchMode === "trackpad" ? <Touchpad size={18} /> : <Pointer size={18} />}
              <span>{touchMode === "trackpad" ? "Trackpad" : "Touch"}</span>
            </button>
            <button
              type="button"
              className="rs-dock-button"
              disabled={zoomScale <= 1}
              onClick={() => applyZoom({ scale: 1, x: 0, y: 0 })}
              aria-label="Reset zoom"
            >
              <Shrink size={18} />
              <span>{zoomScale > 1 ? `${zoomScale.toFixed(1)}×` : "Fit"}</span>
            </button>
            <button
              type="button"
              className={`rs-dock-button ${moreOpen ? "rs-dock-on" : ""}`}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              <Ellipsis size={18} />
              <span>More</span>
            </button>
          </div>
          {moreOpen && (
            <div className="rs-sheet" role="dialog" aria-label="More remote support options">
              <div className="rs-sheet-head">
                <strong>Options</strong>
                <button type="button" onClick={() => setMoreOpen(false)} aria-label="Close options">
                  <X size={18} />
                </button>
              </div>
              <button
                type="button"
                className="rs-sheet-row"
                disabled={!canSecureAttention}
                onClick={() => {
                  sendSecureAttention();
                  setMoreOpen(false);
                }}
              >
                {secureAttentionPending ? <Loader2 size={16} className="spin" /> : <LockKeyhole size={16} />}
                <span>
                  Send Ctrl+Alt+Delete
                  <small>
                    {!secureAttentionAvailable
                      ? "Unavailable on this computer"
                      : !controlEnabled
                        ? "Take control first"
                        : "Opens the Windows security screen"}
                  </small>
                </span>
              </button>
              {displays.length > 1 && (
                <label className="rs-sheet-row rs-sheet-select">
                  <Monitor size={16} />
                  <span>
                    Monitor
                    <select
                      value={selectedDisplayId}
                      disabled={!canSelectDisplay}
                      onChange={(event) => {
                        selectDisplay(event.target.value);
                        setMoreOpen(false);
                      }}
                    >
                      {displays.map((item, index) => (
                        <option key={item.id} value={item.id}>
                          {`Monitor ${index + 1}${item.isPrimary ? " (Primary)" : ""} · ${item.width} × ${item.height}`}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              )}
              <button
                type="button"
                className="rs-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  if (!document.fullscreenElement && document.documentElement.requestFullscreen)
                    void document.documentElement
                      .requestFullscreen()
                      .catch(() =>
                        setError(
                          "This browser does not allow full screen. On iPhone, use Share → Add to Home Screen for a full-screen app.",
                        ),
                      );
                  else if (document.fullscreenElement) void document.exitFullscreen();
                  else
                    setError(
                      "This browser does not allow full screen. On iPhone, use Share → Add to Home Screen for a full-screen app.",
                    );
                }}
              >
                <Maximize2 size={16} />
                <span>
                  Full screen
                  <small>Hide the browser bars</small>
                </span>
              </button>
              <button
                type="button"
                className="rs-sheet-row"
                onClick={() => {
                  setMoreOpen(false);
                  setHelpOpen(true);
                }}
              >
                <CircleHelp size={16} />
                <span>
                  Touch gestures
                  <small>How to click, right-click, drag, scroll and zoom</small>
                </span>
              </button>
              <p className="rs-sheet-status">
                <Signal size={12} />
                {connected ? "Secure relay connected" : "Relay disconnected"}
                {hasFrame && fps > 0 ? ` · ${fps} fps` : ""}
                {display.width > 0 ? ` · ${display.width} × ${display.height}` : ""}
              </p>
            </div>
          )}
        </div>
      )}
      {helpOpen && (
        <div className="rs-help-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="rs-help"
            role="dialog"
            aria-label="Touch gestures"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rs-sheet-head">
              <strong>Touch gestures</strong>
              <button type="button" onClick={() => setHelpOpen(false)} aria-label="Close help">
                <X size={18} />
              </button>
            </div>
            <p className="rs-help-mode">
              {touchMode === "trackpad"
                ? "Trackpad mode: drag one finger anywhere to move the pointer, like a laptop trackpad."
                : "Touch mode: the pointer goes wherever you touch the screen."}
            </p>
            <ul>
              <li>
                <b>Tap</b>
                <span>{touchMode === "trackpad" ? "Left click at the pointer" : "Left click where you tap"}</span>
              </li>
              <li>
                <b>Double tap</b>
                <span>Double click</span>
              </li>
              <li>
                <b>Press and hold</b>
                <span>Right click (lift when the ring fills)</span>
              </li>
              <li>
                <b>Hold, then move</b>
                <span>Drag with the left button held</span>
              </li>
              {touchMode === "direct" && (
                <li>
                  <b>Drag one finger</b>
                  <span>Drag (select text, move windows)</span>
                </li>
              )}
              <li>
                <b>Two-finger tap</b>
                <span>Right click</span>
              </li>
              <li>
                <b>Two-finger drag</b>
                <span>Scroll</span>
              </li>
              <li>
                <b>Pinch</b>
                <span>Zoom in to see small text; Fit zooms back out</span>
              </li>
            </ul>
            <p className="rs-help-foot">
              Keyboard opens your phone’s keyboard. Its key row adds Esc, Tab, arrows, F-keys and one-shot Ctrl, Alt,
              Shift and Win: tap Ctrl, then a letter, for shortcuts like Ctrl+C.
            </p>
            <button type="button" className="rs-help-done" onClick={() => setHelpOpen(false)}>
              Got it
            </button>
          </div>
        </div>
      )}
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
              {fps > 0
                ? `${fps} fps`
                : `Still screen · updated ${Math.max(0, Math.floor((now - frameAt) / 1000))}s ago`}
            </>
          ) : (
            <>
              <ShieldCheck size={12} />
              No desktop is displayed
            </>
          )}
        </span>
        <span className="rs-footer-limit">
          {secureDesktop
            ? "No clipboard or file transfer"
            : "No clipboard or file transfer · Protected Windows prompts cannot be controlled"}
        </span>
      </footer>
    </div>
  );
}
