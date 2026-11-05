using System.Runtime.InteropServices;

namespace LibraryRmm.Support;

internal sealed class DesktopInput(Func<Rectangle> selectedBounds, Func<Rectangle> indicatorBounds, Func<IntPtr> indicatorHandle, Func<bool> desktopAvailable)
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
            if (!desktopAvailable()) return;
            var second = Environment.TickCount64 / 1000;
            if (second != lastSecond) { lastSecond = second; events = 0; }
            if (++events > 200) return;
            if (input.Action == "releaseAll") { ReleaseAllCore(); return; }
            if (input.Action is "keyDown" or "keyUp")
            {
                var key = input.Key!;
                var up = input.Action == "keyUp";
                if (!up && GetForegroundWindow() == indicatorHandle()) return;
                // Do not release an unrelated physical key the operator never pressed.
                if (up && !pressedKeys.Contains(key)) return;
                SendKey(key, up);
                if (up) pressedKeys.Remove(key); else pressedKeys.Add(key);
                return;
            }
            var screen = selectedBounds();
            var mapped = input.X.HasValue ? new SupportDisplayGeometry("selected", screen.Left, screen.Top, screen.Width, screen.Height).MapNormalized(input.X.Value, input.Y!.Value) : (Cursor.Position.X, Cursor.Position.Y);
            var point = new Point(mapped.Item1, mapped.Item2);
            if (indicatorBounds().Contains(point)) return; // Remote control cannot hide/change the visible sharing UI.
            if (input.X.HasValue) Move(point);
            switch (input.Action)
            {
                case "down": Mouse(ButtonFlag(input.Button!.Value, up: false)); pressedButtons.Add(input.Button.Value); break;
                case "up": if (pressedButtons.Remove(input.Button!.Value)) Mouse(ButtonFlag(input.Button.Value, up: true)); break;
                case "wheel": Mouse(0x800, unchecked((uint)-input.DeltaY!.Value)); break;
            }
        }
    }
    public void ReleaseAllIfSafe()
    {
        lock (sync) if (desktopAvailable()) ReleaseAllCore();
    }
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
        var bounds = SystemInformation.VirtualScreen;
        var value = new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput
        {
            X = (int)Math.Round((point.X - bounds.Left) * 65535d / Math.Max(1, bounds.Width - 1)),
            Y = (int)Math.Round((point.Y - bounds.Top) * 65535d / Math.Max(1, bounds.Height - 1)), Flags = 0xc001
        } } };
        Send(value);
    }
    private static void Mouse(uint flags, uint data = 0) => Send(new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput { Flags = flags, Data = data } } });
    private static void SendKey(string key, bool up)
    {
        var extended = key is "ControlRight" or "AltRight" or "MetaLeft" or "MetaRight" or "NumpadEnter" or "NumpadDivide" or "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" || key.StartsWith("Arrow", StringComparison.Ordinal);
        Send(new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = SupportInput.Keys[key], Flags = (up ? 2u : 0u) | (extended ? 1u : 0u) } } });
    }
    private static void Send(Input value)
    {
        // SendInput obeys UIPI. No UIAccess, elevated helper or secure-desktop workaround is used.
        if (SendInput(1, [value], Marshal.SizeOf<Input>()) != 1) throw new InvalidOperationException("Windows refused input (a higher-integrity window may be focused).");
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public IntPtr Extra; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
}
