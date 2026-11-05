using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace LibraryRmm.Support;

/// <summary>
/// Remote support when nobody is signed in. The LocalSystem service starts this helper as SYSTEM in the
/// console session; it follows the console's input desktop (sign-in, lock, Ctrl+Alt+Delete and, when the
/// session policy allows, the desktop of whoever signs in). It creates no windows, so no SYSTEM-owned UI is
/// exposed to the person at the computer. Ctrl+Alt+Shift+F12 at the computer ends the session.
/// </summary>
internal sealed class SignInScreenSession(SupportBootstrap bootstrap, StreamReader servicePipe, StreamWriter serviceWriter) : IDisposable
{
    private readonly SupportConnection connection = new(bootstrap);
    private readonly InputDesktopThread desktopThread = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim serviceWriting = new(1, 1);
    private readonly object displayLock = new();
    private DesktopInput? input;
    private string selectedId = "";
    private Rectangle selectedBounds;
    private string displaysSignature = "";
    private volatile bool controllerConnected;
    private volatile bool serverActive;
    private volatile bool consented;
    private volatile bool pausedRemote;
    private bool sawController;
    private int ending;

    public async Task RunAsync()
    {
        input = new DesktopInput(() => { lock (displayLock) return selectedBounds; }, () => Rectangle.Empty, () => IntPtr.Zero, () => true);
        var monitors = await desktopThread.RunAsync(() => { desktopThread.Attach(); return InputDesktopThread.Monitors(); });
        if (monitors.Count == 0) return;
        var primary = monitors.FirstOrDefault(monitor => monitor.IsPrimary) ?? monitors[0];
        lock (displayLock) { selectedId = primary.Id; selectedBounds = primary.Bounds; displaysSignature = Signature(monitors); }
        var service = WatchServiceAsync();
        var hotkey = WatchHotkeyAsync();
        try
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                await connection.ConnectAsync(timeout.Token);
            }
            await SafeSendAsync(new { type = "capabilities", secureAttention = true, secureDesktop = false });
            await AdvertiseAsync(monitors);
            _ = CaptureLoopAsync();
            await connection.ReceiveAsync(OnRelayMessageAsync, lifetime.Token);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
        finally { await StopAsync("relay_disconnected"); }
        await Task.WhenAny(Task.WhenAll(service, hotkey), Task.Delay(2000));
    }

    private static string Signature(IReadOnlyList<InputDesktopThread.Monitor> monitors) =>
        string.Join("|", monitors.OrderBy(monitor => monitor.Id, StringComparer.Ordinal).Select(monitor => monitor.Id + ":" + monitor.Bounds));

    private Task AdvertiseAsync(IReadOnlyList<InputDesktopThread.Monitor> monitors) => SafeSendAsync(new
    {
        type = "displays",
        displays = monitors.Take(16).Select((monitor, index) => new
        { id = monitor.Id, name = "Display " + (index + 1) + (monitor.IsPrimary ? " (primary)" : ""), width = monitor.Bounds.Width, height = monitor.Bounds.Height, isPrimary = monitor.IsPrimary }).ToArray()
    });

    private Task SendDisplayAsync()
    {
        string id; Rectangle bounds;
        lock (displayLock) { id = selectedId; bounds = selectedBounds; }
        return SafeSendAsync(new { type = "display", id, width = bounds.Width, height = bounds.Height });
    }

    private async Task OnRelayMessageAsync(JsonElement message)
    {
        if (!message.TryGetProperty("type", out var typeValue) || typeValue.ValueKind != JsonValueKind.String) throw new InvalidDataException("Invalid relay message.");
        switch (typeValue.GetString())
        {
            case "state":
                if (!message.TryGetProperty("session", out var session) || !session.TryGetProperty("status", out var state)) throw new InvalidDataException("Invalid support state.");
                var connected = message.TryGetProperty("controllerConnected", out var ready) && ready.ValueKind == JsonValueKind.True;
                if (!connected && sawController) { await StopAsync("controller_disconnected"); return; }
                controllerConnected = connected; sawController |= connected;
                var status = state.GetString();
                if (status is "stopped" or "expired" or "declined" or "failed") { await StopAsync("session_ended"); return; }
                serverActive = status == "active";
                if (status == "awaiting_consent" && connected && !consented)
                {
                    // Nobody is signed in, so there is no person to notify. The relay audits this decision.
                    consented = true;
                    await SafeSendAsync(new { type = "consent", approved = true, control = bootstrap.Grant.RequestedControl, userName = "Windows sign-in screen", decision = "signin_screen" });
                    await SendDisplayAsync();
                }
                return;
            case "input":
                if (!Allowed(control: true)) return;
                var value = SupportInput.Parse(message);
                await desktopThread.RunAsync(() => { if (desktopThread.Attach() is not null) input!.Apply(value); return true; });
                return;
            case "stop": await StopAsync("operator_ended"); return;
            case "selectDisplay":
                if (!message.TryGetProperty("displayId", out var displayId) || displayId.ValueKind != JsonValueKind.String || displayId.GetString()!.Length > 100)
                    throw new InvalidDataException("Invalid display selection.");
                await SelectDisplayAsync(displayId.GetString()!);
                return;
            case "secureAttention":
                if (!message.TryGetProperty("requestId", out var request) || request.ValueKind != JsonValueKind.String || !Guid.TryParseExact(request.GetString(), "D", out _))
                    throw new InvalidDataException("Invalid secure-attention request.");
                if (!Allowed(control: true))
                {
                    await SafeSendAsync(new { type = "secureAttentionResult", requestId = request.GetString(), success = false, message = "not_available" });
                    return;
                }
                await serviceWriting.WaitAsync(lifetime.Token);
                try { await serviceWriter.WriteLineAsync(JsonSerializer.Serialize(new { type = "secureAttention", requestId = request.GetString() }).AsMemory(), lifetime.Token); }
                finally { serviceWriting.Release(); }
                return;
            default: throw new InvalidDataException("Unsupported relay message.");
        }
    }

    private bool Allowed(bool control) => ending == 0 && consented && controllerConnected && serverActive && !pausedRemote &&
        DateTimeOffset.UtcNow < bootstrap.Grant.ExpiresAt && (!control || bootstrap.Grant.RequestedControl);

    private async Task SelectDisplayAsync(string id)
    {
        if (!Allowed(control: false)) return;
        var monitor = (await desktopThread.RunAsync(InputDesktopThread.Monitors)).FirstOrDefault(item => item.Id == id);
        if (monitor is null) { await StopAsync("selected_display_unavailable"); return; }
        await desktopThread.RunAsync(() => { input!.ReleaseAllIfSafe(); return true; });
        await SafeSendAsync(new { type = "paused", paused = true, reason = "selecting_display" });
        lock (displayLock) { selectedId = monitor.Id; selectedBounds = monitor.Bounds; }
        await SendDisplayAsync();
        await SafeSendAsync(new { type = "paused", paused = false, reason = "display_selected" });
    }

    private async Task CaptureLoopAsync()
    {
        DateTimeOffset? waitingSince = null;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                if (DateTimeOffset.UtcNow >= bootstrap.Grant.ExpiresAt) { await StopAsync("session_expired"); return; }
                if (consented && controllerConnected && serverActive)
                {
                    var tick = await desktopThread.RunAsync(() =>
                    {
                        var desktop = desktopThread.Attach();
                        var step = SignInScreenPolicy.Decide(desktop, InputDesktopThread.UserSignedIn(bootstrap.UserSessionId), bootstrap.Grant);
                        var monitors = desktop is null ? [] : InputDesktopThread.Monitors();
                        byte[]? frame = null;
                        if (step == SignInScreenPolicy.Step.Continue && monitors.Count > 0)
                        {
                            lock (displayLock)
                            {
                                var current = monitors.FirstOrDefault(item => item.Id == selectedId) ?? monitors.FirstOrDefault(item => item.IsPrimary) ?? monitors[0];
                                selectedId = current.Id; selectedBounds = current.Bounds;
                            }
                            Rectangle bounds; lock (displayLock) bounds = selectedBounds;
                            frame = DesktopCapture.Capture(bounds);
                        }
                        return (step, monitors, frame);
                    });
                    if (tick.step == SignInScreenPolicy.Step.EndUserSignedIn) { await StopAsync("user_signed_in"); return; }
                    if (tick.step == SignInScreenPolicy.Step.Wait || tick.frame is null)
                    {
                        // The console moved to another Windows session (or is switching). Pause, then give up.
                        waitingSince ??= DateTimeOffset.UtcNow;
                        if (!pausedRemote) { pausedRemote = true; await SafeSendAsync(new { type = "paused", paused = true, reason = "desktop_unavailable" }); }
                        if (DateTimeOffset.UtcNow - waitingSince > TimeSpan.FromSeconds(30)) { await StopAsync("console_session_changed"); return; }
                    }
                    else
                    {
                        waitingSince = null;
                        var signature = Signature(tick.monitors);
                        bool changed; lock (displayLock) { changed = signature != displaysSignature; displaysSignature = signature; }
                        if (changed) { await AdvertiseAsync(tick.monitors); await SendDisplayAsync(); }
                        if (pausedRemote) { pausedRemote = false; await SafeSendAsync(new { type = "paused", paused = false, reason = "desktop_available" }); }
                        await connection.SendFrameAsync(tick.frame, lifetime.Token);
                    }
                }
                await Task.Delay(333, lifetime.Token);
            }
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { await StopAsync("capture_or_relay_failed"); }
    }

    private async Task WatchHotkeyAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                if (await desktopThread.RunAsync(() => desktopThread.Attach() is not null && InputDesktopThread.EmergencyKeysDown()))
                { await StopAsync("local_emergency_hotkey"); return; }
                await Task.Delay(150, lifetime.Token);
            }
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
    }

    private async Task WatchServiceAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                heartbeat.CancelAfter(TimeSpan.FromSeconds(8));
                var line = await SupportPipeFraming.ReadLineAsync(servicePipe, 512, heartbeat.Token);
                if (line is null) break;
                if (line == "SERVICE-ALIVE") continue;
                using var document = JsonDocument.Parse(line);
                var result = document.RootElement;
                if (result.GetProperty("type").GetString() != "secureAttentionResult" ||
                    !Guid.TryParseExact(result.GetProperty("requestId").GetString(), "D", out _) ||
                    result.GetProperty("message").GetString() is not ("sent" or "policy_not_enabled" or "not_available" or "failed")) break;
                await SafeSendAsync(new
                {
                    type = "secureAttentionResult", requestId = result.GetProperty("requestId").GetString(),
                    success = result.GetProperty("success").GetBoolean(), message = result.GetProperty("message").GetString()
                });
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException or JsonException or InvalidOperationException or KeyNotFoundException) { }
        await StopAsync("management_service_disconnected");
    }

    private async Task SafeSendAsync(object value)
    {
        try { if (connection.Connected) await connection.SendJsonAsync(value, lifetime.Token); }
        catch (Exception exception) when (exception is not OutOfMemoryException) { await StopAsync("relay_send_failed"); }
    }

    private async Task StopAsync(string reason)
    {
        if (Interlocked.Exchange(ref ending, 1) != 0) return;
        try { await desktopThread.RunAsync(() => { if (desktopThread.Attach() is not null) input?.ReleaseAllIfSafe(); return true; }).WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
            if (connection.Connected) await connection.SendJsonAsync(new { type = "stop", reason }, timeout.Token);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
        lifetime.Cancel(); connection.Abort();
    }

    public void Dispose()
    {
        lifetime.Cancel(); connection.Abort();
        desktopThread.Dispose(); connection.Dispose(); serviceWriting.Dispose(); lifetime.Dispose();
    }
}

/// <summary>
/// One window-less thread that switches itself to the console's current input desktop before every capture,
/// input or keyboard check. SetThreadDesktop requires a thread that owns no windows or hooks.
/// </summary>
internal sealed class InputDesktopThread : IDisposable
{
    internal sealed record Monitor(string Id, Rectangle Bounds, bool IsPrimary);
    private readonly BlockingCollection<Action> work = new();
    private readonly Thread thread;
    private IntPtr current;
    private string? currentName;

    public InputDesktopThread()
    {
        // MTA on purpose: an STA thread can get a hidden COM window, and SetThreadDesktop fails on threads that own windows.
        thread = new Thread(() => { foreach (var item in work.GetConsumingEnumerable()) item(); }) { IsBackground = true, Name = "Input desktop" };
        thread.Start();
    }

    public Task<T> RunAsync<T>(Func<T> operation)
    {
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            work.Add(() =>
            {
                try { completion.SetResult(operation()); }
                catch (Exception exception) { completion.SetException(exception); }
            });
        }
        catch (InvalidOperationException exception) { completion.SetException(exception); }
        return completion.Task;
    }

    /// <summary>Must run on this thread. Returns the input desktop's name ("Winlogon", "Default", ...), or null when this
    /// Windows session is not attached to the console.</summary>
    public string? Attach()
    {
        var desktop = OpenInputDesktop(0, false, 0x10000000);
        if (desktop == IntPtr.Zero) return null;
        var name = new StringBuilder(256);
        if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * sizeof(char), out _)) { CloseDesktop(desktop); return null; }
        if (current != IntPtr.Zero && string.Equals(currentName, name.ToString(), StringComparison.OrdinalIgnoreCase)) { CloseDesktop(desktop); return currentName; }
        if (!SetThreadDesktop(desktop)) { CloseDesktop(desktop); return null; }
        if (current != IntPtr.Zero) CloseDesktop(current);
        current = desktop; currentName = name.ToString();
        return currentName;
    }

    public static bool UserSignedIn(int sessionId)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 5, out var buffer, out _)) return false;
        try { return !string.IsNullOrEmpty(Marshal.PtrToStringUni(buffer)); }
        finally { WTSFreeMemory(buffer); }
    }

    public static bool EmergencyKeysDown() =>
        (GetAsyncKeyState(0x11) & 0x8000) != 0 && (GetAsyncKeyState(0x12) & 0x8000) != 0 &&
        (GetAsyncKeyState(0x10) & 0x8000) != 0 && (GetAsyncKeyState(0x7b) & 0x8000) != 0;

    public static IReadOnlyList<Monitor> Monitors()
    {
        var monitors = new List<Monitor>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (handle, _, _, _) =>
        {
            var info = new MonitorInfoEx { Size = Marshal.SizeOf<MonitorInfoEx>() };
            if (GetMonitorInfo(handle, ref info) && monitors.Count < 16)
                monitors.Add(new Monitor(info.Device, Rectangle.FromLTRB(info.Monitor.Left, info.Monitor.Top, info.Monitor.Right, info.Monitor.Bottom), (info.Flags & 1) != 0));
            return true;
        }, IntPtr.Zero);
        return monitors;
    }

    public void Dispose()
    {
        work.CompleteAdding();
        if (thread.Join(TimeSpan.FromSeconds(2)) && current != IntPtr.Zero) CloseDesktop(current);
        work.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MonitorInfoEx
    {
        public int Size; public NativeRect Monitor; public NativeRect Work; public int Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    private delegate bool MonitorEnum(IntPtr monitor, IntPtr context, IntPtr rect, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnum callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfoEx info);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "WTSQuerySessionInformationW")] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int information, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
}
