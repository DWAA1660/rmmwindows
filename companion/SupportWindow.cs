using System.Runtime.InteropServices;
using System.Text.Json;

namespace LibraryRmm.Support;

/// <summary>Configured notice/details UI and emergency hotkey. Form visibility never owns the transport lifetime.</summary>
internal sealed class SupportWindow : Form
{
    private const int EmergencyHotkey = 0x524d;
    private readonly SupportBootstrap bootstrap;
    private readonly StreamReader servicePipe;
    private readonly StreamWriter serviceWriter;
    private readonly SemaphoreSlim serviceWriting = new(1, 1);
    private readonly SupportConnection connection;
    private readonly SupportPermissionGate permission;
    private readonly CancellationTokenSource lifetime = new();
    private Rectangle desktop;
    private string selectedDisplayId;
    private string displaysSignature;
    private readonly DesktopInput input;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    private readonly Label heading = new() { AutoSize = false, Font = new Font("Segoe UI", 15, FontStyle.Bold) };
    private readonly Label description = new() { AutoSize = false, Font = new Font("Segoe UI", 10) };
    private readonly Label status = new() { AutoSize = false, Font = new Font("Segoe UI", 10, FontStyle.Bold) };
    private readonly Button approve = new() { Text = "Approve now", Enabled = false };
    private readonly Button decline = new() { Text = "Decline" };
    private readonly Button resume = new() { Text = "Resume sharing", Visible = false };
    private readonly CheckBox allowControl = new() { Text = "Allow mouse and keyboard control", AutoSize = true };
    private readonly object windowBoundsLock = new();
    private Rectangle protectedBounds;
    private IntPtr protectedHandle;
    private DateTimeOffset? noticeStarted;
    private volatile bool controllerConnected;
    private volatile bool serverActive;
    private bool sawController;
    private bool lastPaused;
    private bool approved;
    private bool switchingDisplay;
    private bool updatingDisplays;
    private int ending;
    private int began;
    private bool disposed;

    public SupportWindow(SupportBootstrap bootstrap, StreamReader servicePipe, StreamWriter serviceWriter)
    {
        this.bootstrap = bootstrap; this.servicePipe = servicePipe; this.serviceWriter = serviceWriter;
        var primary = Screen.PrimaryScreen ?? throw new InvalidOperationException("No primary monitor is available.");
        desktop = primary.Bounds;
        selectedDisplayId = primary.DeviceName;
        displaysSignature = DisplaySignature();
        connection = new SupportConnection(bootstrap);
        permission = new SupportPermissionGate(bootstrap, () => DateTimeOffset.UtcNow, DesktopAvailable, () => controllerConnected && serverActive);
        input = new DesktopInput(() => desktop, () => { lock (windowBoundsLock) return protectedBounds; }, () => protectedHandle, DesktopAvailable);
        Text = "Park County Library — IT support";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ClientSize = new Size(650, 275);
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false; MinimizeBox = false; TopMost = true; ShowInTaskbar = true;
        BackColor = Color.FromArgb(245, 248, 250);
        heading.SetBounds(20, 16, 610, 30);
        description.SetBounds(20, 52, 610, 70);
        status.SetBounds(20, 125, 610, 28);
        allowControl.SetBounds(20, 160, 600, 25);
        approve.SetBounds(350, 215, 130, 36); decline.SetBounds(495, 215, 130, 36);
        resume.SetBounds(475, 55, 150, 32);
        heading.Text = bootstrap.Grant.OperatorName + " requests remote support";
        description.Text = "Library IT will see your screens" + (bootstrap.Grant.RequestedControl ? " and may move your mouse and use your keyboard" : "") +
            $". Sharing begins after approval or {bootstrap.Grant.ApprovalSeconds} seconds unless you Decline. " +
            (bootstrap.Grant.ShowSessionDetails ? "Close this notice to decline." : "THIS NOTICE THEN CLOSES; SHARING CONTINUES WITH NO ICON OR BANNER. End any time: Ctrl+Alt+Shift+F12.");
        if (!bootstrap.Grant.ShowSessionDetails)
        {
            ClientSize = new Size(650, 315);
            description.Height = 105; status.Top = 165; allowControl.Top = 200; approve.Top = 255; decline.Top = 255;
        }
        status.Text = "Connecting to the identified operator — no sharing yet.";
        allowControl.Checked = bootstrap.Grant.RequestedControl;
        allowControl.Visible = bootstrap.Grant.RequestedControl;
        Controls.AddRange([heading, description, status, allowControl, approve, decline, resume]);
        approve.Click += async (_, _) => await DecideAsync("manual");
        decline.Click += async (_, _) => await StopAsync("staff_declined", declineRequest: true);
        resume.Click += async (_, _) =>
        {
            try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
            if (!controllerConnected || !serverActive || !permission.ResumeLocally()) return;
            lastPaused = false; resume.Visible = false;
            await SafeSendAsync(new { type = "paused", paused = false, reason = "resumed_locally" });
            RefreshSharingText();
        };
        Move += (_, _) => RememberBounds(); Resize += (_, _) => RememberBounds();
        timer.Tick += async (_, _) => await TickAsync();
        Shown += async (_, _) => await BeginAsync();
        FormClosing += async (_, args) =>
        {
            if (ending == 0) { args.Cancel = true; await StopAsync("staff_closed", declineRequest: !approved); }
            else EndImmediately();
        };
        if (!bootstrap.Grant.ApprovalRequired) ConfigureIndicator();
    }

    private bool DesktopAvailable() => DesktopAccess.Available(bootstrap.UserSessionId) &&
        Screen.AllScreens.Any(screen => screen.DeviceName == selectedDisplayId && screen.Bounds == desktop);
    private static string DisplaySignature() => string.Join("|", Screen.AllScreens.OrderBy(screen => screen.DeviceName, StringComparer.Ordinal).Select(screen => screen.DeviceName + ":" + screen.Bounds));
    private void RememberBounds() { lock (windowBoundsLock) protectedBounds = Visible ? Bounds : Rectangle.Empty; }
    private Task AdvertiseDisplaysAsync() => SafeSendAsync(new
    {
        type = "displays",
        displays = Screen.AllScreens.Take(16).Select((screen, index) => new
        { id = screen.DeviceName, name = "Display " + (index + 1) + (screen.Primary ? " (primary)" : ""), width = screen.Bounds.Width, height = screen.Bounds.Height, isPrimary = screen.Primary }).ToArray()
    });
    private async Task BeginAsync()
    {
        if (Interlocked.Exchange(ref began, 1) != 0) return;
        protectedHandle = Handle; RememberBounds();
        // No Stop button by the user's latest policy: a functioning emergency
        // hotkey is mandatory. If registration fails, this session cannot start.
        if (!RegisterHotKey(Handle, EmergencyHotkey, 0x4007, 0x7b))
        {
            MessageBox.Show(this, "Ctrl+Alt+Shift+F12 is unavailable. Remote sharing will not start.", "Remote support unavailable", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            await StopAsync("emergency_hotkey_unavailable"); return;
        }
        timer.Start();
        _ = WatchServiceAsync();
        _ = CaptureLoopAsync();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await connection.ConnectAsync(timeout.Token);
            await SafeSendAsync(new { type = "capabilities", secureAttention = true, secureDesktop = false });
            await AdvertiseDisplaysAsync();
            await connection.ReceiveAsync(OnRelayMessageAsync, lifetime.Token);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
        finally { await StopAsync("relay_disconnected"); }
    }
    private async Task OnRelayMessageAsync(JsonElement message)
    {
        if (!message.TryGetProperty("type", out var typeValue) || typeValue.ValueKind != JsonValueKind.String) throw new InvalidDataException("Invalid relay message.");
        switch (typeValue.GetString())
        {
            case "input":
                if (!controllerConnected || !serverActive) return;
                var value = SupportInput.Parse(message);
                permission.TryInput(() => input.Apply(value));
                return;
            case "state":
                if (!message.TryGetProperty("session", out var session) || !session.TryGetProperty("status", out var state)) throw new InvalidDataException("Invalid support state.");
                var connected = message.TryGetProperty("controllerConnected", out var ready) && ready.ValueKind == JsonValueKind.True;
                if (!connected && sawController) { await StopAsync("controller_disconnected"); return; }
                controllerConnected = connected;
                sawController |= connected;
                if (state.GetString() is "stopped" or "expired" or "declined" or "failed") { await StopAsync("session_ended"); return; }
                serverActive = state.GetString() == "active";
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
                var allowed = controllerConnected && serverActive && permission.TryInput(() => { });
                if (!allowed)
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
    private async Task TickAsync()
    {
        if (ending != 0) return;
        if (DateTimeOffset.UtcNow >= bootstrap.Grant.ExpiresAt || permission.IsEnded) { await StopAsync("session_expired"); return; }
        if (approved && !switchingDisplay && !updatingDisplays && displaysSignature != DisplaySignature())
        {
            updatingDisplays = true;
            try
            {
                permission.PauseLocally();
                try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
                if (!bootstrap.Grant.ShowSessionDetails) { await StopAsync("display_configuration_changed_hidden_session"); return; }
                await SafeSendAsync(new { type = "paused", paused = true, reason = "display_configuration_changed" });
                await AdvertiseDisplaysAsync();
                var selected = Screen.AllScreens.FirstOrDefault(screen => screen.DeviceName == selectedDisplayId);
                if (selected is null) { await StopAsync("selected_display_removed"); return; }
                desktop = selected.Bounds; displaysSignature = DisplaySignature();
                await SafeSendAsync(new { type = "display", id = selectedDisplayId, width = desktop.Width, height = desktop.Height });
            }
            finally { updatingDisplays = false; }
        }
        if (!approved)
        {
            if (!controllerConnected) return;
            if (!DesktopAvailable()) { await StopAsync("desktop_unavailable_before_approval", true); return; }
            if (!noticeStarted.HasValue)
            {
                if (!permission.BeginLocalAccessPolicy()) return;
                noticeStarted = DateTimeOffset.UtcNow;
                approve.Enabled = true;
            }
            if (!bootstrap.Grant.ApprovalRequired) { await DecideAsync("unattended"); return; }
            var seconds = Math.Max(0, bootstrap.Grant.ApprovalSeconds - (int)(DateTimeOffset.UtcNow - noticeStarted.Value).TotalSeconds);
            status.Text = $"Sharing starts in {seconds} seconds unless you choose Decline.";
            if (seconds == 0) await DecideAsync("automatic");
        }
        else if (permission.IsPaused && !lastPaused && !switchingDisplay && !updatingDisplays)
        {
            if (!bootstrap.Grant.ShowSessionDetails) { await StopAsync("desktop_changed_hidden_session"); return; }
            lastPaused = true;
            try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
            resume.Visible = true;
            status.Text = "PAUSED — return to your desktop, then click Resume sharing.";
            await SafeSendAsync(new { type = "paused", paused = true, reason = "desktop_unavailable" });
        }
    }
    private async Task DecideAsync(string decision)
    {
        if (approved || ending != 0 || !controllerConnected) return;
        var accepted = decision switch
        {
            "manual" => permission.ApproveLocally(allowControl.Checked),
            "automatic" => permission.ApproveAfterVisibleCountdown(allowControl.Checked),
            "unattended" => permission.ApproveImmediatePolicy(allowControl.Checked),
            _ => false
        };
        if (!accepted) return;
        approved = true;
        ConfigureIndicator();
        await SafeSendAsync(new { type = "consent", approved = true, control = permission.HasControl, userName = Environment.UserDomainName + "\\" + Environment.UserName, decision });
        await SafeSendAsync(new { type = "display", id = selectedDisplayId, width = desktop.Width, height = desktop.Height });
    }
    private void ConfigureIndicator()
    {
        if (approved && !bootstrap.Grant.ShowSessionDetails)
        {
            // The enrolled server snapshots both independent administrator settings. This
            // branch hides details after their configured manual/countdown/immediate policy.
            lock (windowBoundsLock) protectedBounds = Rectangle.Empty;
            Hide();
            return;
        }
        ControlBox = false;
        ClientSize = new Size(650, 105);
        Location = new Point(desktop.Left + Math.Max(0, (desktop.Width - Width) / 2), desktop.Top + 5);
        heading.Text = approved ? "LIBRARY IT IS SHARING YOUR SCREEN" : "LIBRARY IT REMOTE SUPPORT — CONNECTING";
        heading.Font = new Font("Segoe UI", 12, FontStyle.Bold);
        description.SetBounds(20, 48, 440, 38);
        description.Text = bootstrap.Grant.OperatorName + (approved ? permission.HasControl ? " — mouse and keyboard enabled" : " — view only" : " — waiting for the operator");
        status.SetBounds(20, 82, 610, 20); status.Font = new Font("Segoe UI", 9, FontStyle.Bold);
        approve.Visible = false; decline.Visible = false; allowControl.Visible = false;
        RefreshSharingText(); RememberBounds();
    }
    private void RefreshSharingText() => status.Text = "End locally at any time: Ctrl + Alt + Shift + F12";
    private async Task SelectDisplayAsync(string id)
    {
        if (!controllerConnected || !serverActive || !permission.IsApproved || switchingDisplay || updatingDisplays) return;
        var selected = Screen.AllScreens.FirstOrDefault(screen => screen.DeviceName == id);
        if (selected is null) { await StopAsync("selected_display_unavailable"); return; }
        switchingDisplay = true;
        try
        {
            permission.PauseLocally();
            try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
            await SafeSendAsync(new { type = "paused", paused = true, reason = "selecting_display" });
            desktop = selected.Bounds; selectedDisplayId = selected.DeviceName; displaysSignature = DisplaySignature();
            await SafeSendAsync(new { type = "display", id = selectedDisplayId, width = desktop.Width, height = desktop.Height });
            if (!permission.ResumeLocally())
            {
                if (!bootstrap.Grant.ShowSessionDetails) await StopAsync("desktop_unavailable_hidden_session");
                return;
            }
            lastPaused = false;
            if (bootstrap.Grant.ShowSessionDetails) { resume.Visible = false; ConfigureIndicator(); }
            await SafeSendAsync(new { type = "paused", paused = false, reason = "display_selected" });
        }
        finally { switchingDisplay = false; }
    }
    private async Task CaptureLoopAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                if (controllerConnected && serverActive)
                {
                    byte[]? frame = null;
                    permission.TryCapture(() => frame = DesktopCapture.Capture(desktop));
                    if (frame is not null) await connection.SendFrameAsync(frame, lifetime.Token);
                }
                await Task.Delay(333, lifetime.Token);
            }
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { await StopAsync("capture_or_relay_failed"); }
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
                if (line.Length > 512) break;
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
    private async Task StopAsync(string reason, bool declineRequest = false)
    {
        if (Interlocked.Exchange(ref ending, 1) != 0) return;
        permission.End();
        try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
            if (connection.Connected)
                await connection.SendJsonAsync(declineRequest && !approved
                    ? new { type = "consent", approved = false, control = false, userName = Environment.UserName, decision = "manual" } as object
                    : new { type = "stop", reason }, timeout.Token);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException) { }
        EndImmediately();
        if (!IsDisposed && IsHandleCreated) BeginInvoke(Close);
    }
    private void EndImmediately()
    {
        if (disposed) return;
        Interlocked.Exchange(ref ending, 1);
        permission.End();
        try { input.ReleaseAllIfSafe(); } catch (InvalidOperationException) { }
        lifetime.Cancel(); connection.Abort();
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0312 && message.WParam.ToInt32() == EmergencyHotkey) { _ = StopAsync("local_emergency_hotkey"); return; }
        base.WndProc(ref message);
    }
    protected override void SetVisibleCore(bool value)
    {
        if (value && !bootstrap.Grant.ShowSessionDetails && !bootstrap.Grant.ApprovalRequired)
        {
            // Application.Run normally shows its main form. Retain only the message/hotkey
            // handle for the explicitly configured no-notice/no-details policy; never flash it.
            if (!IsHandleCreated) CreateHandle();
            base.SetVisibleCore(false);
            return;
        }
        base.SetVisibleCore(value);
    }
    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        if (!bootstrap.Grant.ShowSessionDetails && !bootstrap.Grant.ApprovalRequired && began == 0)
            BeginInvoke(async () => await BeginAsync());
        else if (began != 0)
        {
            protectedHandle = Handle;
            if (!RegisterHotKey(Handle, EmergencyHotkey, 0x4007, 0x7b)) { permission.End(); _ = StopAsync("emergency_hotkey_unavailable"); }
        }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            EndImmediately(); timer.Stop(); timer.Dispose();
            if (IsHandleCreated) UnregisterHotKey(Handle, EmergencyHotkey);
            connection.Dispose(); lifetime.Dispose();
            disposed = true;
        }
        base.Dispose(disposing);
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
}
