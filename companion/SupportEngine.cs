using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace LibraryRmm.Support;

/// <summary>
/// The screen helper (agent 0.1.11+). The LocalSystem service starts it as SYSTEM in the target Windows session. It
/// creates no windows. One thread captures and one applies input; each switches itself to the session's current input
/// desktop first, so the regular desktop, Ctrl+Alt+Delete, lock, sign-in and UAC screens all keep streaming and stay
/// controllable. A signed-in user's own desktop is shown only after the notice in their session approves (relayed by
/// the service), unless the administrator turned off both the notice and the indicator. Ctrl+Alt+Shift+F12 at the
/// computer ends the session on any of those screens.
/// </summary>
internal sealed class SupportEngine(SupportBootstrap bootstrap, StreamReader servicePipe, StreamWriter serviceWriter) : IDisposable
{
    private readonly SupportConnection connection = new(bootstrap);
    private readonly InputDesktopThread captureThread = new("Screen capture");
    private readonly InputDesktopThread inputThread = new("Remote input");
    private readonly FrameEncoder encoder = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim serviceWriting = new(1, 1);
    private readonly object displayLock = new();
    private readonly object flowLock = new();
    private DesktopInput? input;
    private string selectedId = "";
    private Rectangle selectedBounds;
    private string displaysSignature = "";
    private volatile string serverStatus = "requested";
    private volatile bool controllerConnected;
    private int consentState;
    private bool serverConsentSent => Volatile.Read(ref consentState) != 0;
    private volatile bool userConsented;
    private volatile bool controlAllowed;
    private volatile bool pausedRemote;
    private volatile bool forceKeyframe = true;
    private volatile bool switchingDisplay;
    private volatile int noticePid;
    private bool sawController;
    private int ending;
    // Flow control: at most two frames are on their way to the browser at once, so the picture never lags behind a queue.
    private uint lastSentSeq, lastAckedSeq;
    private long lastSendTick;
    private string? lastDesktop;

    private bool NoticeRequired => bootstrap.Grant.ApprovalRequired || bootstrap.Grant.ShowSessionDetails;
    private int Session => bootstrap.UserSessionId;

    public async Task RunAsync()
    {
        userConsented = bootstrap.NoNotice;
        controlAllowed = bootstrap.Grant.RequestedControl;
        input = new DesktopInput(() => { lock (displayLock) return selectedBounds; }, IsNoticeWindow);
        var monitors = await captureThread.RunAsync(() => { captureThread.Attach(); return InputDesktopThread.Monitors(); });
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
            await SafeSendAsync(new { type = "capabilities", secureAttention = true, secureDesktop = true, deltaFrames = true });
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
            {
                if (!message.TryGetProperty("session", out var session) || !session.TryGetProperty("status", out var state) || state.ValueKind != JsonValueKind.String)
                    throw new InvalidDataException("Invalid support state.");
                var connected = message.TryGetProperty("controllerConnected", out var ready) && ready.ValueKind == JsonValueKind.True;
                if (!connected && sawController) { await StopAsync("controller_disconnected"); return; }
                sawController |= connected;
                var status = state.GetString()!;
                if (status is "stopped" or "expired" or "declined" or "failed") { await StopAsync("session_ended"); return; }
                serverStatus = status;
                if (connected != controllerConnected)
                {
                    controllerConnected = connected;
                    // The notice starts its countdown only once the operator is actually watching.
                    await WriteServiceAsync(new { type = "controller", connected });
                }
                await TrySendInitialConsentAsync();
                return;
            }
            case "input":
            {
                if (!Allowed(control: true)) return;
                var value = SupportInput.Parse(message);
                // Queued, not awaited: input has its own thread so it never waits behind a screen capture.
                _ = inputThread.RunAsync(() =>
                {
                    try { if (inputThread.Attach() is not null) input!.Apply(value); }
                    catch (InvalidDataException) { }
                    return true;
                });
                return;
            }
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
                // The service generates the real secure attention sequence, honoring Windows policy. It is never a key chord.
                await WriteServiceAsync(new { type = "secureAttention", requestId = request.GetString() });
                return;
            case "frameAck":
                if (!message.TryGetProperty("seq", out var seqValue) || !seqValue.TryGetUInt32(out var seq)) throw new InvalidDataException("Invalid frame acknowledgement.");
                lock (flowLock) if (unchecked((int)(seq - lastAckedSeq)) > 0 && unchecked((int)(lastSentSeq - seq)) >= 0) lastAckedSeq = seq;
                return;
            case "keyframe":
                // The relay dropped a frame or the browser cleared its picture: repaint everything next.
                lock (flowLock) lastAckedSeq = lastSentSeq;
                forceKeyframe = true;
                return;
            default: throw new InvalidDataException("Unsupported relay message.");
        }
    }

    private bool Allowed(bool control) => ending == 0 && serverConsentSent && controllerConnected && serverStatus == "active" && !pausedRemote && !switchingDisplay &&
        DateTimeOffset.UtcNow < bootstrap.Grant.ExpiresAt && (!control || controlAllowed);

    /// <summary>The relay's first consent. Without a person to ask (sign-in screen, locked session, or no notice configured)
    /// the helper answers itself; otherwise the notice on the user's desktop answers through the service.</summary>
    private async Task TrySendInitialConsentAsync()
    {
        if (serverConsentSent || serverStatus != "awaiting_consent" || !controllerConnected || ending != 0) return;
        string decision, name;
        var signedIn = SessionInfo.UserSignedIn(Session);
        if (bootstrap.NoNotice) { decision = signedIn && bootstrap.UserPresent ? "unattended" : "signin_screen"; name = signedIn && bootstrap.UserPresent ? bootstrap.UserName! : "Windows sign-in screen"; }
        else if (!signedIn) { decision = "signin_screen"; name = "Windows sign-in screen"; }
        else if (SessionInfo.IsLocked(Session)) { decision = "signin_screen"; name = "Windows lock screen"; }
        else return;
        // Called from the relay reader and the capture loop: the relay accepts exactly one consent.
        if (!TryClaimConsent()) return;
        forceKeyframe = true;
        await SafeSendAsync(new { type = "consent", approved = true, control = controlAllowed, userName = name, decision });
        await SendDisplayAsync();
    }

    private async Task OnUserConsentAsync(SupportPipeMessages.Message message)
    {
        var decision = message.Text("decision");
        if (!SupportPipeMessages.Decisions.Contains(decision)) { await StopAsync("management_service_disconnected"); return; }
        if (!message.Bool("approved")) { await StopAsync("staff_declined"); return; }
        controlAllowed = bootstrap.Grant.RequestedControl && message.Bool("control");
        userConsented = true;
        forceKeyframe = true;
        if (!controlAllowed) _ = inputThread.RunAsync(() => { if (inputThread.Attach() is not null) input!.ReleaseAll(); return true; });
        if (serverStatus == "awaiting_consent" && TryClaimConsent())
        {
            await SafeSendAsync(new { type = "consent", approved = true, control = controlAllowed, userName = message.Text("userName"), decision });
            await SendDisplayAsync();
        }
        else if (serverConsentSent) await SafeSendAsync(new { type = "userConsent", approved = true, control = controlAllowed, userName = message.Text("userName"), decision });
    }

    private bool TryClaimConsent() => Interlocked.Exchange(ref consentState, 1) == 0;

    private async Task SelectDisplayAsync(string id)
    {
        if (!Allowed(control: false)) return;
        var monitor = (await captureThread.RunAsync(() => { captureThread.Attach(); return InputDesktopThread.Monitors(); })).FirstOrDefault(item => item.Id == id);
        if (monitor is null) { await StopAsync("selected_display_unavailable"); return; }
        switchingDisplay = true;
        try
        {
            await inputThread.RunAsync(() => { if (inputThread.Attach() is not null) input!.ReleaseAll(); return true; });
            await SafeSendAsync(new { type = "paused", paused = true, reason = "selecting_display" });
            lock (displayLock) { selectedId = monitor.Id; selectedBounds = monitor.Bounds; }
            await SendDisplayAsync();
            lock (flowLock) lastAckedSeq = lastSentSeq;
            forceKeyframe = true;
            await SafeSendAsync(new { type = "paused", paused = false, reason = "display_selected" });
        }
        finally { switchingDisplay = false; }
    }

    private sealed record Tick(SupportAccessPolicy.Step Step, IReadOnlyList<InputDesktopThread.Monitor>? Monitors, byte[]? Frame);

    private async Task CaptureLoopAsync()
    {
        DateTimeOffset? waitingSince = null;
        var lastNoticeRequest = DateTimeOffset.MinValue;
        var lastChange = Environment.TickCount64;
        var failures = 0;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var delay = 100;
                if (DateTimeOffset.UtcNow >= bootstrap.Grant.ExpiresAt) { await StopAsync("session_expired"); return; }
                if (!serverConsentSent) await TrySendInitialConsentAsync();
                if (serverConsentSent && serverStatus == "active" && controllerConnected && !switchingDisplay)
                {
                    bool canSend, heartbeat; uint seq;
                    lock (flowLock)
                    {
                        var now = Environment.TickCount64;
                        // Acknowledgements stopped (lost frames): assume nothing is in flight and repaint.
                        if (lastSentSeq - lastAckedSeq >= 2 && now - lastSendTick > 3000) { lastAckedSeq = lastSentSeq; forceKeyframe = true; }
                        canSend = lastSentSeq - lastAckedSeq < 2;
                        heartbeat = now - lastSendTick > 1000;
                        seq = unchecked(lastSentSeq + 1);
                    }
                    Tick tick;
                    try { tick = await captureThread.RunAsync(() => Capture(canSend, seq, heartbeat)); failures = 0; }
                    catch (Exception exception) when (exception is Win32Exception or ExternalException or InvalidOperationException or ArgumentException)
                    {
                        // Capture fails briefly while Windows switches desktops (Ctrl+Alt+Delete, sign-in, UAC). Keep going.
                        forceKeyframe = true;
                        if (++failures > 150) { await StopAsync("capture_or_relay_failed"); return; }
                        await Task.Delay(100, lifetime.Token);
                        continue;
                    }
                    if (tick.Step == SupportAccessPolicy.Step.Wait)
                    {
                        // This Windows session is not attached to the console (user switching or a remote session took over).
                        waitingSince ??= DateTimeOffset.UtcNow;
                        await SetPausedAsync(true, "desktop_unavailable");
                        if (DateTimeOffset.UtcNow - waitingSince > TimeSpan.FromSeconds(30)) { await StopAsync("console_session_changed"); return; }
                        delay = 250;
                    }
                    else if (tick.Step == SupportAccessPolicy.Step.NeedUserConsent)
                    {
                        // Someone signed in (or unlocked) and their desktop needs the configured notice first.
                        waitingSince = null;
                        await SetPausedAsync(true, "waiting_for_user");
                        if (DateTimeOffset.UtcNow - lastNoticeRequest > TimeSpan.FromSeconds(4))
                        {
                            lastNoticeRequest = DateTimeOffset.UtcNow;
                            await WriteServiceAsync(new { type = "needNotice" });
                        }
                        delay = 250;
                    }
                    else
                    {
                        waitingSince = null;
                        var signature = Signature(tick.Monitors!);
                        bool changed; lock (displayLock) { changed = signature != displaysSignature; displaysSignature = signature; }
                        if (changed) { await AdvertiseAsync(tick.Monitors!); await SendDisplayAsync(); forceKeyframe = true; }
                        await SetPausedAsync(false, "desktop_available");
                        if (tick.Frame is not null)
                        {
                            await connection.SendFrameAsync(tick.Frame, lifetime.Token);
                            lock (flowLock) { lastSentSeq = seq; lastSendTick = Environment.TickCount64; }
                            if (tick.Frame.Length > 14) lastChange = Environment.TickCount64;
                        }
                        // Changes are usually followed by more changes: look again soon. A screen that has been still
                        // for a few seconds is checked less often. While two frames are unacknowledged, poll for the ack.
                        var still = Environment.TickCount64 - lastChange;
                        delay = !canSend ? 10 : still < 500 ? 15 : still < 3000 ? 50 : 120;
                    }
                }
                await Task.Delay(delay, lifetime.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception exception) when (exception is not OutOfMemoryException) { await StopAsync("capture_or_relay_failed"); }
    }

    /// <summary>Runs on the capture thread.</summary>
    private Tick Capture(bool canSend, uint seq, bool heartbeat)
    {
        var desktop = captureThread.Attach();
        // Session facts matter only until the signed-in user's consent is known; skip the WTS calls afterwards.
        var consented = userConsented;
        var signedIn = !consented && SessionInfo.UserSignedIn(Session);
        var step = SupportAccessPolicy.Decide(desktop, signedIn, signedIn && SessionInfo.IsLocked(Session), consented, bootstrap.Grant);
        if (step != SupportAccessPolicy.Step.Continue) { lastDesktop = null; return new Tick(step, null, null); }
        var monitors = InputDesktopThread.Monitors();
        if (monitors.Count == 0) return new Tick(SupportAccessPolicy.Step.Wait, null, null);
        Rectangle bounds;
        lock (displayLock)
        {
            var current = monitors.FirstOrDefault(item => item.Id == selectedId) ?? monitors.FirstOrDefault(item => item.IsPrimary) ?? monitors[0];
            selectedId = current.Id; selectedBounds = current.Bounds; bounds = current.Bounds;
        }
        byte[]? frame = null;
        if (canSend)
        {
            // A different desktop (Ctrl+Alt+Delete, lock, sign-in, UAC) is a whole new picture.
            var keyframe = forceKeyframe || !string.Equals(desktop, lastDesktop, StringComparison.OrdinalIgnoreCase);
            forceKeyframe = false;
            frame = encoder.Next(bounds, seq, keyframe, heartbeat);
            lastDesktop = desktop;
        }
        return new Tick(step, monitors, frame);
    }

    private async Task SetPausedAsync(bool paused, string reason)
    {
        if (pausedRemote == paused) return;
        pausedRemote = paused;
        if (paused)
        {
            forceKeyframe = true;
            _ = inputThread.RunAsync(() => { if (inputThread.Attach() is not null) input!.ReleaseAll(); return true; });
        }
        await SafeSendAsync(new { type = "paused", paused, reason });
    }

    private bool IsNoticeWindow(IntPtr window)
    {
        var pid = noticePid;
        if (pid == 0 || window == IntPtr.Zero) return false;
        GetWindowThreadProcessId(GetAncestor(window, 2), out var owner);
        return owner == pid;
    }

    private async Task WatchHotkeyAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                if (await inputThread.RunAsync(() => inputThread.Attach() is not null && InputDesktopThread.EmergencyKeysDown()))
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
                var line = await SupportPipeFraming.ReadLineAsync(servicePipe, SupportPipeMessages.MaximumLine, heartbeat.Token);
                if (line is null) break;
                if (line == "SERVICE-ALIVE") continue;
                var message = SupportPipeMessages.Parse(line, SupportPipeMessages.ToEngine);
                switch (message.Type)
                {
                    case "secureAttentionResult":
                        var result = message.Text("message");
                        if (result is not ("sent" or "policy_not_enabled" or "not_available" or "failed")) throw new InvalidDataException("Invalid secure-attention result.");
                        if (result == "sent") forceKeyframe = true;
                        await SafeSendAsync(new { type = "secureAttentionResult", requestId = message.Text("requestId"), success = message.Bool("success"), message = result });
                        break;
                    case "notice": noticePid = message.Int("pid"); break;
                    case "noticeClosed":
                        noticePid = 0;
                        // The person's indicator (and their way to decline) is gone, so their desktop is no longer shared.
                        if (NoticeRequired) { await StopAsync("notice_closed"); return; }
                        break;
                    case "userConsent": await OnUserConsentAsync(message); break;
                    case "stop": await StopAsync(message.Text("reason")); return;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException or JsonException or InvalidOperationException or InvalidDataException or KeyNotFoundException) { }
        await StopAsync("management_service_disconnected");
    }

    private async Task WriteServiceAsync(object value)
    {
        try
        {
            await serviceWriting.WaitAsync(lifetime.Token);
            try { await serviceWriter.WriteLineAsync(JsonSerializer.Serialize(value, SupportBootstrap.Json).AsMemory(), lifetime.Token); }
            finally { serviceWriting.Release(); }
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException) { await StopAsync("management_service_disconnected"); }
    }

    private async Task SafeSendAsync(object value)
    {
        try { if (connection.Connected) await connection.SendJsonAsync(value, lifetime.Token); }
        catch (Exception exception) when (exception is not OutOfMemoryException) { await StopAsync("relay_send_failed"); }
    }

    private async Task StopAsync(string reason)
    {
        if (Interlocked.Exchange(ref ending, 1) != 0) return;
        try { await inputThread.RunAsync(() => { if (inputThread.Attach() is not null) input?.ReleaseAll(); return true; }).WaitAsync(TimeSpan.FromSeconds(1)); }
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
        captureThread.Dispose(); inputThread.Dispose(); encoder.Dispose(); connection.Dispose(); serviceWriting.Dispose(); lifetime.Dispose();
    }

    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
}

/// <summary>Windows session facts read through WTS. Safe from any thread.</summary>
internal static class SessionInfo
{
    public static bool UserSignedIn(int sessionId)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 5, out var buffer, out _)) return false;
        try { return !string.IsNullOrEmpty(Marshal.PtrToStringUni(buffer)); }
        finally { WTSFreeMemory(buffer); }
    }

    /// <summary>True only when Windows reports the session as locked (WTSINFOEX level 1 SessionFlags == WTS_SESSIONSTATE_LOCK).</summary>
    public static bool IsLocked(int sessionId)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 25, out var buffer, out var length)) return false;
        try
        {
            if (length < 20) return false;
            var header = new byte[20];
            Marshal.Copy(buffer, header, 0, header.Length);
            return SupportSessionFacts.IsLockedInfo(header);
        }
        finally { WTSFreeMemory(buffer); }
    }

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "WTSQuerySessionInformationW")] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int information, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
}

/// <summary>
/// One window-less thread that switches itself to the session's current input desktop before every capture, input or
/// keyboard check. SetThreadDesktop requires a thread that owns no windows or hooks.
/// </summary>
internal sealed class InputDesktopThread : IDisposable
{
    internal sealed record Monitor(string Id, Rectangle Bounds, bool IsPrimary);
    private readonly BlockingCollection<Action> work = new();
    private readonly Thread thread;
    private IntPtr current;
    private string? currentName;

    public InputDesktopThread(string name)
    {
        // MTA on purpose: an STA thread can get a hidden COM window, and SetThreadDesktop fails on threads that own windows.
        thread = new Thread(() => { foreach (var item in work.GetConsumingEnumerable()) item(); }) { IsBackground = true, Name = name, Priority = ThreadPriority.AboveNormal };
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
}
