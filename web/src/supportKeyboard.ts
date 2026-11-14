/**
 * Phone and tablet typing for remote support.
 *
 * Soft keyboards do not report physical key codes (Android sends keyCode 229, autocorrect rewrites whole words, iOS
 * inserts curly quotes), so the support window types through a hidden text box instead: every change to its text is
 * diffed against the previous value and replayed as the KeyboardEvent.code key presses the relay already accepts.
 * Codes follow the US keyboard layout used by the library's computers. Characters with no US key are reported as
 * skipped instead of being sent as something else.
 */
export type Modifier = "ControlLeft" | "AltLeft" | "ShiftLeft" | "MetaLeft";
export type KeyStroke = { code: string; shift: boolean };
export type KeyEventMessage = { action: "keyDown" | "keyUp"; key: string };

const letters = /^[a-z]$/;
const shiftedDigits = ")!@#$%^&*(";
const punctuation: Record<string, KeyStroke> = {
  "`": { code: "Backquote", shift: false },
  "~": { code: "Backquote", shift: true },
  "-": { code: "Minus", shift: false },
  _: { code: "Minus", shift: true },
  "=": { code: "Equal", shift: false },
  "+": { code: "Equal", shift: true },
  "[": { code: "BracketLeft", shift: false },
  "{": { code: "BracketLeft", shift: true },
  "]": { code: "BracketRight", shift: false },
  "}": { code: "BracketRight", shift: true },
  "\\": { code: "Backslash", shift: false },
  "|": { code: "Backslash", shift: true },
  ";": { code: "Semicolon", shift: false },
  ":": { code: "Semicolon", shift: true },
  "'": { code: "Quote", shift: false },
  '"': { code: "Quote", shift: true },
  ",": { code: "Comma", shift: false },
  "<": { code: "Comma", shift: true },
  ".": { code: "Period", shift: false },
  ">": { code: "Period", shift: true },
  "/": { code: "Slash", shift: false },
  "?": { code: "Slash", shift: true },
  " ": { code: "Space", shift: false },
  "\n": { code: "Enter", shift: false },
  "\t": { code: "Tab", shift: false },
};
// Phone keyboards substitute typographic characters; type the plain character the user meant.
const typographic: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "″": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  " ": " ",
  " ": " ",
  "\r": "",
};

/** Key strokes for one character on a US layout, or null when no key types it. */
export function charToStrokes(character: string): KeyStroke[] | null {
  const plain = typographic[character] ?? character;
  if (plain === "") return [];
  const parts = [...plain];
  if (parts.length > 1) {
    const expanded = parts.map(charToStrokes);
    return expanded.every(Boolean) ? expanded.flat() as KeyStroke[] : null;
  }
  if (letters.test(plain)) return [{ code: `Key${plain.toUpperCase()}`, shift: false }];
  if (letters.test(plain.toLowerCase()))
    return [{ code: `Key${plain}`, shift: true }];
  if (/^[0-9]$/.test(plain)) return [{ code: `Digit${plain}`, shift: false }];
  const shiftedDigit = shiftedDigits.indexOf(plain);
  if (shiftedDigit >= 0) return [{ code: `Digit${shiftedDigit}`, shift: true }];
  const stroke = punctuation[plain];
  return stroke ? [stroke] : null;
}

/** Key strokes for a run of text, counting characters (emoji, accents) that a US keyboard cannot type. */
export function textToStrokes(text: string): {
  strokes: KeyStroke[];
  skipped: number;
} {
  const strokes: KeyStroke[] = [];
  let skipped = 0;
  for (const character of text) {
    const next = charToStrokes(character);
    if (next) strokes.push(...next);
    else skipped++;
  }
  return { strokes, skipped };
}

/**
 * What changed between two values of the hidden text box: characters removed from the end of the common prefix
 * (sent as Backspace) and the characters typed after it. Handles autocorrect, swipe typing and IME composition,
 * which replace whole words instead of sending one key at a time.
 */
export function diffText(
  before: string,
  after: string,
): { deletions: number; insert: string } {
  const a = [...before],
    b = [...after];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  return { deletions: a.length - prefix, insert: b.slice(prefix).join("") };
}

/**
 * Down/up messages for strokes, holding Shift across consecutive shifted characters and any one-shot modifiers
 * (Ctrl, Alt, Win, Shift from the on-screen key row) around the whole run. Every key pressed is released.
 */
export function strokesToMessages(
  strokes: KeyStroke[],
  modifiers: readonly Modifier[] = [],
): KeyEventMessage[] {
  if (!strokes.length) return [];
  const messages: KeyEventMessage[] = [];
  const held = new Set<string>(modifiers);
  for (const modifier of modifiers) messages.push({ action: "keyDown", key: modifier });
  const stickyShift = held.has("ShiftLeft");
  let shiftDown = stickyShift;
  for (const stroke of strokes) {
    const wantShift = stickyShift || stroke.shift;
    if (wantShift && !shiftDown) {
      messages.push({ action: "keyDown", key: "ShiftLeft" });
      shiftDown = true;
    } else if (!wantShift && shiftDown) {
      messages.push({ action: "keyUp", key: "ShiftLeft" });
      shiftDown = false;
    }
    messages.push({ action: "keyDown", key: stroke.code });
    messages.push({ action: "keyUp", key: stroke.code });
  }
  if (shiftDown && !stickyShift) messages.push({ action: "keyUp", key: "ShiftLeft" });
  for (const modifier of [...modifiers].reverse())
    messages.push({ action: "keyUp", key: modifier });
  return messages;
}

/** Messages for one named key (from the on-screen key row or a hardware keyboard) with one-shot modifiers. */
export function keyToMessages(
  code: string,
  modifiers: readonly Modifier[] = [],
): KeyEventMessage[] {
  return strokesToMessages([{ code, shift: false }], modifiers);
}

/** Text kept in the hidden box so Backspace on an apparently empty field still produces a change to diff. */
export const KEYBOARD_SENTINEL = "        ";
