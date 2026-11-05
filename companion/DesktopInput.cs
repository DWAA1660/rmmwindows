using System.Runtime.InteropServices;

namespace LibraryRmm.Support;

/// <summary>
/// Applies relayed mouse and keyboard input with SendInput on the calling thread's desktop. The screen helper runs as
/// SYSTEM and attaches to the session's input desktop first, so input reaches the regular desktop, elevated windows and
/// the Windows sign-in, lock, Ctrl+Alt+Delete and UAC screens. Native Ctrl+Alt+Delete itself is never synthesized here.
/// </summary>
internal sealed class DesktopInput(Func<Rectangle> selectedBounds, Func<IntPtr, bool> isProtectedWindow)
{
    private readonly object sync = new();
    private readonly HashSet<string> pressedKeys = new(StringComparer.Ordinal);
    private readonly HashSet<int> pressedButtons = [];
    private long lastSecond;
    private int events;

    public void Apply(SupportInput input)
    {
        lock (sync)
        {
            var second = Environment.TickCount64 / 1000;
            if (second != lastSecond) { lastSecond = second; events = 0; }
            if (++events > 400) return;
            if (input.Action == "releaseAll") { ReleaseAllCore(); return; }
            if (input.Action is "keyDown" or "keyUp")
            {
                var key = input.Key!;
                var up = input.Action == "keyUp";
                // Remote typing cannot reach the sharing notice/indicator.
                if (!up && isProtectedWindow(GetForegroundWindow())) return;
                // Do not release an unrelated physical key the operator never pressed.
                if (up && !pressedKeys.Contains(key)) return;
                SendKey(key, up);
                if (up) pressedKeys.Remove(key); else pressedKeys.Add(key);
                return;
            }
            var screen = selectedBounds();
            if (screen.Width < 1 || screen.Height < 1) return;
            var mapped = new SupportDisplayGeometry("selected", screen.Left, screen.Top, screen.Width, screen.Height).MapNormalized(input.X!.Value, input.Y!.Value);
            var point = new Point(mapped.X, mapped.Y);
            Move(point);
            // Remote clicks cannot press, drag or close the sharing notice/indicator.
            if (input.Action != "move" && isProtectedWindow(WindowFromPoint(point)) && !(input.Action == "up" && pressedButtons.Contains(input.Button!.Value))) return;
            switch (input.Action)
            {
                case "down": if (Mouse(ButtonFlag(input.Button!.Value, up: false))) pressedButtons.Add(input.Button.Value); break;
                case "up": if (pressedButtons.Remove(input.Button!.Value)) Mouse(ButtonFlag(input.Button.Value, up: true)); break;
                case "wheel": Mouse(0x800, unchecked((uint)-input.DeltaY!.Value)); break;
            }
        }
    }

    public void ReleaseAll() { lock (sync) ReleaseAllCore(); }

    private void ReleaseAllCore()
    {
        foreach (var key in pressedKeys) SendKey(key, true);
        pressedKeys.Clear();
        foreach (var button in pressedButtons) Mouse(ButtonFlag(button, true));
        pressedButtons.Clear();
    }
    private static uint ButtonFlag(int button, bool up) => button switch { 0 => up ? 4u : 2u, 1 => up ? 64u : 32u, 2 => up ? 16u : 8u, _ => throw new ArgumentOutOfRangeException(nameof(button)) };
    private static void Move(Point point)
    {
        // Absolute coordinates over the whole virtual desktop (MOUSEEVENTF_MOVE | ABSOLUTE | VIRTUALDESK).
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        Send(new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput
        {
            X = (int)Math.Round((point.X - left) * 65535d / Math.Max(1, width - 1)),
            Y = (int)Math.Round((point.Y - top) * 65535d / Math.Max(1, height - 1)), Flags = 0xc001
        } } });
    }
    private static bool Mouse(uint flags, uint data = 0) => Send(new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput { Flags = flags, Data = data } } });
    private static void SendKey(string key, bool up)
    {
        var extended = key is "ControlRight" or "AltRight" or "MetaLeft" or "MetaRight" or "NumpadEnter" or "NumpadDivide" or "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" || key.StartsWith("Arrow", StringComparison.Ordinal);
        var virtualKey = SupportInput.Keys[key];
        // The scan code is included so programs that read it (games, remote consoles, the sign-in screen) see a normal key.
        Send(new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput
        {
            VirtualKey = virtualKey, Scan = (ushort)MapVirtualKey(virtualKey, 0), Flags = (up ? 2u : 0u) | (extended ? 1u : 0u)
        } } });
    }
    /// <summary>False when Windows refused the input (for example while the desktop is switching). It is not retried.</summary>
    private static bool Send(Input value) => SendInput(1, [value], Marshal.SizeOf<Input>()) == 1;

    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public IntPtr Extra; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint mapType);
}
