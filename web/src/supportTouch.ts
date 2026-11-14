/**
 * Touch gestures for the remote desktop on phones and tablets.
 *
 * Two modes, like the common remote desktop apps:
 *  - "trackpad": one finger moves the remote pointer relative to where it is (precise on a small screen);
 *    tap = left click at the pointer.
 *  - "direct": the remote pointer goes where the finger touches; tap = left click there, and dragging holds the
 *    left button (select text, move windows).
 * In both modes:
 *  - press and hold, then lift = right click; press and hold, then move = drag with the left button held;
 *  - two-finger tap = right click; two-finger drag = scroll wheel; pinch = zoom the local view (with panning).
 *
 * The recognizer only turns touches into actions. The support window turns actions into relay input messages,
 * so every consent, pause and control check stays where it already is.
 */
export type TouchMode = "trackpad" | "direct";
export type ClientRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type Point = { x: number; y: number };
export type GestureAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "down" | "up"; button: 0 | 2; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaY: number }
  | {
      kind: "zoom";
      factor: number;
      originX: number;
      originY: number;
      panX: number;
      panY: number;
    }
  | { kind: "hold"; clientX: number; clientY: number }
  | { kind: "holdEnd"; fired: boolean };
export type TouchPoint = {
  id: number;
  clientX: number;
  clientY: number;
  time: number;
};

export const TAP_SLOP = 10;
export const HOLD_MS = 550;
export const TWO_FINGER_TAP_MS = 350;
export const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_SLOP = 30;
const PINCH_START = 22;
const SCROLL_START = 10;
const SCROLL_STEP = 24;
const SCROLL_GAIN = 3;

type Tracked = { startX: number; startY: number; x: number; y: number; startTime: number; time: number };
type Phase =
  | "idle"
  | "pending" // one finger down, not yet a tap, drag or hold
  | "moving" // trackpad: moving the pointer without a button
  | "dragging" // a left-button drag is in progress
  | "held" // hold fired, waiting to see whether the finger lifts (right click) or moves (drag)
  | "twoPending"
  | "pinching"
  | "scrolling"
  | "ignore"; // until every finger lifts (after a multi-finger gesture or a cancel)

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export class TouchGestures {
  mode: TouchMode;
  /** Normalized remote pointer position used by trackpad mode. */
  cursor: Point = { x: 0.5, y: 0.5 };
  private phase: Phase = "idle";
  private touches = new Map<number, Tracked>();
  private holdTimer: (() => void) | null = null;
  private holdPoint: Point | null = null;
  private startDistance = 0;
  private lastDistance = 0;
  private lastMid: Point = { x: 0, y: 0 };
  private startMid: Point = { x: 0, y: 0 };
  private twoStart = 0;
  private scrollRemainder = 0;
  private lastTap: { time: number; clientX: number; clientY: number; at: Point } | null = null;

  private readonly emit: (action: GestureAction) => void;
  private readonly rect: () => ClientRect | null;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;

  constructor(
    emit: (action: GestureAction) => void,
    rect: () => ClientRect | null,
    mode: TouchMode = "trackpad",
    setTimer: (callback: () => void, ms: number) => () => void = (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
  ) {
    this.emit = emit;
    this.rect = rect;
    this.mode = mode;
    this.setTimer = setTimer;
  }

  /** Normalized remote coordinates for a client point on the displayed desktop. */
  private normalize(clientX: number, clientY: number, strict = false): Point | null {
    const rect = this.rect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    // Taps and drag starts must land on the picture; a drag already in progress may run past its edge.
    if (strict && (clientX < rect.left || clientY < rect.top || clientX > rect.left + rect.width || clientY > rect.top + rect.height))
      return null;
    return {
      x: clamp((clientX - rect.left) / rect.width),
      y: clamp((clientY - rect.top) / rect.height),
    };
  }
  private target(clientX: number, clientY: number): Point | null {
    return this.mode === "trackpad" ? { ...this.cursor } : this.normalize(clientX, clientY, true);
  }
  private cancelHold() {
    this.holdTimer?.();
    this.holdTimer = null;
  }
  private click(button: 0 | 2, at: Point) {
    this.emit({ kind: "move", ...at });
    this.emit({ kind: "down", button, ...at });
    this.emit({ kind: "up", button, ...at });
  }
  private releaseDrag() {
    if (this.phase === "dragging")
      this.emit({ kind: "up", button: 0, ...this.dragPoint() });
  }
  private dragPoint(): Point {
    if (this.mode === "trackpad") return { ...this.cursor };
    const only = [...this.touches.values()][0];
    return (only && this.normalize(only.x, only.y)) || this.holdPoint || { x: 0.5, y: 0.5 };
  }

  down(point: TouchPoint) {
    if (this.phase === "ignore") {
      this.touches.set(point.id, this.track(point));
      return;
    }
    this.touches.set(point.id, this.track(point));
    if (this.touches.size === 1) {
      this.phase = "pending";
      this.holdPoint = this.target(point.clientX, point.clientY);
      this.emit({ kind: "hold", clientX: point.clientX, clientY: point.clientY });
      this.cancelHold();
      this.holdTimer = this.setTimer(() => this.holdFired(), HOLD_MS);
      return;
    }
    if (this.touches.size === 2) {
      // A second finger turns whatever the first one was doing into a two-finger gesture.
      this.cancelHold();
      if (this.phase === "pending") this.emit({ kind: "holdEnd", fired: false });
      this.releaseDrag();
      if (this.phase === "held") this.emit({ kind: "holdEnd", fired: false });
      const [a, b] = [...this.touches.values()];
      this.startDistance = this.lastDistance = Math.hypot(a.x - b.x, a.y - b.y);
      this.startMid = this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.twoStart = point.time;
      this.scrollRemainder = 0;
      this.phase = "twoPending";
      return;
    }
    // Three or more fingers: stop and wait for a clean start.
    this.cancel();
  }

  private track(point: TouchPoint): Tracked {
    return {
      startX: point.clientX,
      startY: point.clientY,
      x: point.clientX,
      y: point.clientY,
      startTime: point.time,
      time: point.time,
    };
  }

  private holdFired() {
    this.holdTimer = null;
    if (this.phase !== "pending") return;
    this.phase = "held";
    // The hold indicator stays until the finger lifts or starts a drag.
  }

  move(point: TouchPoint) {
    const tracked = this.touches.get(point.id);
    if (!tracked) return;
    const dx = point.clientX - tracked.x,
      dy = point.clientY - tracked.y,
      dt = Math.max(1, point.time - tracked.time);
    tracked.x = point.clientX;
    tracked.y = point.clientY;
    tracked.time = point.time;
    const travelled = Math.hypot(
      point.clientX - tracked.startX,
      point.clientY - tracked.startY,
    );
    switch (this.phase) {
      case "pending":
        if (travelled < TAP_SLOP) return;
        this.cancelHold();
        this.emit({ kind: "holdEnd", fired: false });
        if (this.mode === "trackpad") {
          this.phase = "moving";
          this.nudge(point.clientX - tracked.startX, point.clientY - tracked.startY, dt);
        } else {
          // Direct mode: a drag presses the left button where the finger first touched.
          const start = this.normalize(tracked.startX, tracked.startY, true);
          const now = this.normalize(point.clientX, point.clientY);
          if (!start || !now) {
            this.phase = "ignore";
            return;
          }
          this.emit({ kind: "move", ...start });
          this.emit({ kind: "down", button: 0, ...start });
          this.emit({ kind: "move", ...now });
          this.phase = "dragging";
        }
        return;
      case "held": {
        if (travelled < TAP_SLOP) return;
        // Hold, then move: drag with the left button from where the hold started.
        this.emit({ kind: "holdEnd", fired: false });
        const start = this.mode === "trackpad" ? { ...this.cursor } : this.holdPoint;
        if (!start) {
          this.phase = "ignore";
          return;
        }
        this.emit({ kind: "move", ...start });
        this.emit({ kind: "down", button: 0, ...start });
        this.phase = "dragging";
        if (this.mode === "trackpad")
          this.nudge(point.clientX - tracked.startX, point.clientY - tracked.startY, dt);
        else {
          const now = this.normalize(point.clientX, point.clientY);
          if (now) this.emit({ kind: "move", ...now });
        }
        return;
      }
      case "moving":
        this.nudge(dx, dy, dt);
        return;
      case "dragging":
        if (this.mode === "trackpad") this.nudge(dx, dy, dt);
        else {
          const now = this.normalize(point.clientX, point.clientY);
          if (now) this.emit({ kind: "move", ...now });
        }
        return;
      case "twoPending":
      case "pinching":
      case "scrolling":
        this.twoFingerMove();
        return;
      default:
        return;
    }
  }

  /** Trackpad pointer motion with gentle acceleration for fast swipes. */
  private nudge(dx: number, dy: number, dt: number) {
    const rect = this.rect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const speed = Math.hypot(dx, dy) / dt; // px per ms
    const gain = Math.min(3, Math.max(1, 1 + (speed - 0.35) * 1.4));
    this.cursor = {
      x: clamp(this.cursor.x + (dx * gain) / rect.width),
      y: clamp(this.cursor.y + (dy * gain) / rect.height),
    };
    this.emit({ kind: "move", ...this.cursor });
  }

  private twoFingerMove() {
    if (this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this.phase === "twoPending") {
      if (Math.abs(distance - this.startDistance) >= PINCH_START) this.phase = "pinching";
      else if (Math.hypot(mid.x - this.startMid.x, mid.y - this.startMid.y) >= SCROLL_START)
        this.phase = "scrolling";
      else return;
    }
    if (this.phase === "pinching") {
      this.emit({
        kind: "zoom",
        factor: this.lastDistance > 0 ? distance / this.lastDistance : 1,
        originX: mid.x,
        originY: mid.y,
        panX: mid.x - this.lastMid.x,
        panY: mid.y - this.lastMid.y,
      });
    } else {
      // Fingers moving up scroll the page down, like scrolling a phone screen.
      this.scrollRemainder += -(mid.y - this.lastMid.y) * SCROLL_GAIN;
      if (Math.abs(this.scrollRemainder) >= SCROLL_STEP) {
        const deltaY = Math.max(-1200, Math.min(1200, Math.round(this.scrollRemainder)));
        this.scrollRemainder = 0;
        const at = this.target(mid.x, mid.y);
        if (at) this.emit({ kind: "wheel", ...at, deltaY });
      }
    }
    this.lastDistance = distance;
    this.lastMid = mid;
  }

  up(point: TouchPoint) {
    const tracked = this.touches.get(point.id);
    if (!tracked) return;
    if (this.touches.size === 1) {
      if (this.phase === "dragging" && this.mode === "direct") {
        tracked.x = point.clientX;
        tracked.y = point.clientY;
        const end = this.normalize(point.clientX, point.clientY);
        if (end) this.emit({ kind: "move", ...end });
      }
      switch (this.phase) {
        case "pending": {
          this.cancelHold();
          this.emit({ kind: "holdEnd", fired: false });
          let at =
            this.mode === "trackpad"
              ? { ...this.cursor }
              : this.normalize(tracked.startX, tracked.startY, true);
          // A second tap lands where the first did: one phone pixel is several remote pixels, and
          // Windows only counts a double click when both clicks are within a few pixels.
          const previous = this.lastTap;
          if (
            at &&
            previous &&
            point.time - previous.time <= DOUBLE_TAP_MS &&
            Math.hypot(tracked.startX - previous.clientX, tracked.startY - previous.clientY) <= DOUBLE_TAP_SLOP
          )
            at = { ...previous.at };
          if (at) {
            this.click(0, at);
            this.lastTap = { time: point.time, clientX: tracked.startX, clientY: tracked.startY, at };
          }
          break;
        }
        case "held":
          this.emit({ kind: "holdEnd", fired: true });
          {
            const at = this.mode === "trackpad" ? { ...this.cursor } : this.holdPoint;
            if (at) this.click(2, at);
          }
          break;
        case "dragging":
          this.releaseDrag();
          break;
      }
      this.touches.delete(point.id);
      this.phase = "idle";
      return;
    }
    if (
      this.touches.size === 2 &&
      this.phase === "twoPending" &&
      point.time - this.twoStart <= TWO_FINGER_TAP_MS
    ) {
      const at = this.target(this.lastMid.x, this.lastMid.y);
      if (at) this.click(2, at);
    }
    this.touches.delete(point.id);
    // The remaining finger(s) do nothing until all lift, so a pinch never turns into a stray click or drag.
    this.phase = this.touches.size ? "ignore" : "idle";
  }

  /** Lost capture, cancelled touch, control disabled or the page hidden: release anything held. */
  cancel() {
    this.cancelHold();
    if (this.phase === "pending" || this.phase === "held")
      this.emit({ kind: "holdEnd", fired: false });
    this.releaseDrag();
    this.phase = this.touches.size ? "ignore" : "idle";
  }

  /** A finger lifted outside our view of events (pointercancel): forget it. */
  forget(id: number) {
    this.touches.delete(id);
    if (!this.touches.size) this.phase = "idle";
  }

  get active() {
    return this.touches.size > 0;
  }
}
