import { test } from "node:test";
import assert from "node:assert/strict";
import {
  charToStrokes,
  diffText,
  keyToMessages,
  strokesToMessages,
  textToStrokes,
} from "../src/supportKeyboard.ts";
import { HOLD_MS, TouchGestures } from "../src/supportTouch.ts";

test("US keyboard mapping covers letters, shifted symbols and phone punctuation", () => {
  assert.deepEqual(charToStrokes("a"), [{ code: "KeyA", shift: false }]);
  assert.deepEqual(charToStrokes("Q"), [{ code: "KeyQ", shift: true }]);
  assert.deepEqual(charToStrokes("7"), [{ code: "Digit7", shift: false }]);
  assert.deepEqual(charToStrokes("@"), [{ code: "Digit2", shift: true }]);
  assert.deepEqual(charToStrokes(")"), [{ code: "Digit0", shift: true }]);
  assert.deepEqual(charToStrokes("?"), [{ code: "Slash", shift: true }]);
  assert.deepEqual(charToStrokes("\n"), [{ code: "Enter", shift: false }]);
  // iOS smart punctuation becomes the plain character the user meant.
  assert.deepEqual(charToStrokes("’"), [{ code: "Quote", shift: false }]);
  assert.deepEqual(charToStrokes("“"), [{ code: "Quote", shift: true }]);
  assert.equal(charToStrokes("…").length, 3);
  assert.equal(charToStrokes("é"), null);
  const { strokes, skipped } = textToStrokes("Hi 😀!");
  assert.equal(skipped, 1);
  assert.deepEqual(strokes.map((s) => s.code), ["KeyH", "KeyI", "Space", "Digit1"]);
});

test("text diff handles typing, backspace and autocorrect replacing a word", () => {
  assert.deepEqual(diffText("    ", "    h"), { deletions: 0, insert: "h" });
  assert.deepEqual(diffText("    h", "    "), { deletions: 1, insert: "" });
  assert.deepEqual(diffText("    teh", "    the "), { deletions: 2, insert: "he " });
  assert.deepEqual(diffText("a😀", "a"), { deletions: 1, insert: "" });
});

test("key messages hold Shift across a run and always release every key", () => {
  const messages = strokesToMessages(textToStrokes("AB c").strokes);
  assert.deepEqual(messages.map((m) => `${m.action}:${m.key}`), [
    "keyDown:ShiftLeft",
    "keyDown:KeyA", "keyUp:KeyA",
    "keyDown:KeyB", "keyUp:KeyB",
    "keyUp:ShiftLeft",
    "keyDown:Space", "keyUp:Space",
    "keyDown:KeyC", "keyUp:KeyC",
  ]);
  const ctrlC = strokesToMessages(textToStrokes("c").strokes, ["ControlLeft"]);
  assert.deepEqual(ctrlC.map((m) => `${m.action}:${m.key}`), [
    "keyDown:ControlLeft", "keyDown:KeyC", "keyUp:KeyC", "keyUp:ControlLeft",
  ]);
  const altTab = keyToMessages("Tab", ["AltLeft", "ShiftLeft"]);
  const downs = altTab.filter((m) => m.action === "keyDown").map((m) => m.key);
  const ups = altTab.filter((m) => m.action === "keyUp").map((m) => m.key);
  assert.deepEqual([...downs].sort(), [...ups].sort());
});

function harness(mode) {
  const actions = [];
  const timers = [];
  const rect = { left: 0, top: 0, width: 400, height: 200 };
  const gestures = new TouchGestures((a) => actions.push(a), () => rect, mode, (callback) => {
    const timer = { callback, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  const fire = () => timers.filter((t) => !t.cancelled).forEach((t) => { t.cancelled = true; t.callback(); });
  const remote = () => actions.filter((a) => ["down", "up", "wheel"].includes(a.kind));
  return { actions, gestures, fire, remote };
}
const p = (id, x, y, time = 0) => ({ id, clientX: x, clientY: y, time });

test("direct mode: tap clicks where touched, drag holds the left button", () => {
  const h = harness("direct");
  h.gestures.down(p(1, 100, 50, 0));
  h.gestures.up(p(1, 101, 51, 80));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}@${a.x},${a.y}`), ["down0@0.25,0.25", "up0@0.25,0.25"]);
  h.actions.length = 0;
  h.gestures.down(p(2, 100, 100, 200));
  h.gestures.move(p(2, 200, 100, 260));
  h.gestures.up(p(2, 300, 100, 320));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}`), ["down0", "up0"]);
  assert.equal(h.remote()[1].x, 0.75);
});

test("hold then lift is a right click; hold then move drags", () => {
  const h = harness("direct");
  h.gestures.down(p(1, 200, 100, 0));
  h.fire();
  h.gestures.up(p(1, 200, 100, HOLD_MS + 10));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}`), ["down2", "up2"]);
  h.actions.length = 0;
  h.gestures.down(p(2, 200, 100, 1000));
  h.fire();
  h.gestures.move(p(2, 260, 100, 1700));
  h.gestures.up(p(2, 260, 100, 1750));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}`), ["down0", "up0"]);
});

test("trackpad mode moves the pointer relatively and taps click at the pointer", () => {
  const h = harness("trackpad");
  h.gestures.cursor = { x: 0.5, y: 0.5 };
  h.gestures.down(p(1, 10, 10, 0));
  h.gestures.move(p(1, 50, 10, 400)); // slow: no acceleration, 40px of a 400px view = +0.1
  h.gestures.up(p(1, 50, 10, 420));
  assert.equal(h.remote().length, 0);
  assert.ok(Math.abs(h.gestures.cursor.x - 0.6) < 1e-9);
  h.gestures.down(p(2, 300, 150, 1000));
  h.gestures.up(p(2, 300, 150, 1050));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}@${a.x.toFixed(1)}`), ["down0@0.6", "up0@0.6"]);
});

test("two-finger tap right-clicks, two-finger drag scrolls, pinch zooms without input", () => {
  let h = harness("direct");
  h.gestures.down(p(1, 100, 100, 0));
  h.gestures.down(p(2, 140, 100, 20));
  h.gestures.up(p(1, 100, 100, 120));
  h.gestures.up(p(2, 140, 100, 130));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}`), ["down2", "up2"]);

  h = harness("direct");
  h.gestures.down(p(1, 100, 150, 0));
  h.gestures.down(p(2, 160, 150, 10));
  for (let step = 1; step <= 5; step++) {
    h.gestures.move(p(1, 100, 150 - step * 10, 10 + step * 16));
    h.gestures.move(p(2, 160, 150 - step * 10, 10 + step * 16));
  }
  const wheels = h.remote().filter((a) => a.kind === "wheel");
  assert.ok(wheels.length > 0 && wheels.every((w) => w.deltaY > 0), "fingers moving up scroll down");
  assert.equal(h.remote().filter((a) => a.kind !== "wheel").length, 0);

  h = harness("trackpad");
  h.gestures.down(p(1, 100, 100, 0));
  h.gestures.down(p(2, 140, 100, 10));
  h.gestures.move(p(1, 60, 100, 50));
  h.gestures.move(p(2, 180, 100, 60));
  h.gestures.up(p(1, 60, 100, 500));
  h.gestures.move(p(2, 250, 100, 520)); // remaining finger is ignored
  h.gestures.up(p(2, 250, 100, 540));
  assert.ok(h.actions.some((a) => a.kind === "zoom" && a.factor > 1));
  assert.equal(h.remote().length, 0);
});

test("a second finger during a direct drag releases the button", () => {
  const h = harness("direct");
  h.gestures.down(p(1, 100, 100, 0));
  h.gestures.move(p(1, 150, 100, 50));
  h.gestures.down(p(2, 300, 100, 60));
  assert.deepEqual(h.remote().map((a) => `${a.kind}${a.button}`), ["down0", "up0"]);
  h.gestures.cancel();
  assert.equal(h.remote().length, 2);
});

test("direct mode ignores taps and holds outside the desktop picture", () => {
  const h = harness("direct");
  h.gestures.down(p(1, 100, 350, 0)); // below the 200px-tall picture
  h.gestures.up(p(1, 100, 350, 60));
  h.gestures.down(p(2, 100, 350, 100));
  h.fire();
  h.gestures.up(p(2, 100, 350, 900));
  h.gestures.down(p(3, 100, 350, 1000));
  h.gestures.move(p(3, 100, 150, 1100));
  h.gestures.up(p(3, 100, 150, 1150));
  assert.equal(h.remote().length, 0);
});

test("a quick second tap reuses the first tap's position so Windows sees a double click", () => {
  const h = harness("direct");
  h.gestures.down(p(1, 100, 50, 0));
  h.gestures.up(p(1, 100, 50, 60));
  h.gestures.down(p(2, 112, 58, 200));
  h.gestures.up(p(2, 112, 58, 250));
  const downs = h.remote().filter((a) => a.kind === "down");
  assert.equal(downs.length, 2);
  assert.deepEqual([downs[1].x, downs[1].y], [downs[0].x, downs[0].y]);
  h.gestures.down(p(3, 300, 150, 2000));
  h.gestures.up(p(3, 300, 150, 2050));
  assert.equal(h.remote().filter((a) => a.kind === "down")[2].x, 0.75);
});
