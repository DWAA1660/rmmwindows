using System.Runtime.InteropServices;
using System.Text.Json;

namespace LibraryRmm.Support;

/// <summary>
/// The notice in the signed-in user's own session (non-elevated). It shows the configured approve/decline form with its
/// countdown, then the persistent sharing indicator, and registers Ctrl+Alt+Shift+F12. It never captures the screen,
/// sends input or connects to the network: its decisions go to the service, which relays them to the screen helper.
/// Form visibility never owns the session's lifetime; closing or declining before approval refuses the request.
/// </summary>
internal sealed class SupportWindow : Form
{
    private const int EmergencyHotkey = 0x524d;
    private readonly SupportNoticeBootstrap notice;
    private readonly StreamReader servicePipe;
    private readonly StreamWriter serviceWriter;
    private readonly SemaphoreSlim serviceWriting = new(1, 1);
    private readonly SupportPermissionGate permission;
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    private readonly Label heading = new() { AutoSize = false, Font = new Font("Segoe UI", 15, FontStyle.Bold) };
    private readonly Label description = new() { AutoSize = false, Font = new Font("Segoe UI", 10) };
    private readonly Label status = new() { AutoSize = false, Font = new Font("Segoe UI", 10, FontStyle.Bold) };
    private readonly Button approve = new() { Text = "Approve now", Enabled = false };
    private readonly Button decline = new() { Text = "Decline" };
    private readonly CheckBox allowControl = new() { Text = "Allow mouse and keyboard control", AutoSize = true };
    private DateTimeOffset? noticeStarted;
    private volatile bool controllerConnected;
    private bool approved;
    private int ending;
    private int began;
    private bool disposed;

    public SupportWindow(SupportNoticeBootstrap notice, StreamReader servicePipe, StreamWriter serviceWriter)
    {
        this.notice = notice; this.servicePipe = servicePipe; this.serviceWriter = serviceWriter;
        permission = new SupportPermissionGate(notice, () => DateTimeOffset.UtcNow, () => DesktopAccess.Available(notice.UserSessionId), () => controllerConnected);
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
        heading.Text = notice.OperatorName + " requests remote support";
        description.Text = "Library IT will see your screens" + (notice.RequestedControl ? " and may move your mouse and use your keyboard" : "") +
            $". Sharing begins after approval or {notice.ApprovalSeconds} seconds unless you Decline. " +
            (notice.ShowSessionDetails ? "Close this notice to decline." : "THIS NOTICE THEN CLOSES; SHARING CONTINUES WITH NO ICON OR BANNER. End any time: Ctrl+Alt+Shift+F12.");
        if (!notice.ShowSessionDetails)
        {
            ClientSize = new Size(650, 315);
            description.Height = 105; status.Top = 165; allowControl.Top = 200; approve.Top = 255; decline.Top = 255;
        }
        status.Text = "Connecting to the identified operator — no sharing yet.";
        allowControl.Checked = notice.RequestedControl;
        allowControl.Visible = notice.RequestedControl;
        Controls.AddRange([heading, description, status, allowControl, approve, decline]);
        approve.Click += async (_, _) => await DecideAsync("manual");
        decline.Click += async (_, _) => await StopAsync("staff_declined");
        timer.Tick += async (_, _) => await TickAsync();
        Shown += async (_, _) => await BeginAsync();
        FormClosing += async (_, args) =>
        {
            if (ending == 0) { args.Cancel = true; await StopAsync(approved ? "staff_closed" : "staff_declined"); }
            else EndImmediately();
        };
        if (!notice.ApprovalRequired) ConfigureIndicator();
    }

    private async Task BeginAsync()
    {
        if (Interlocked.Exchange(ref began, 1) != 0) return;
        // No Stop button by the user's policy: a functioning emergency hotkey is mandatory.
        // If registration fails, this session cannot start.
        if (!RegisterHotKey(Handle, EmergencyHotkey, 0x4007, 0x7b))
        {
            MessageBox.Show(this, "Ctrl+Alt+Shift+F12 is unavailable. Remote sharing will not start.", "Remote support unavailable", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            await StopAsync("emergency_hotkey_unavailable"); return;
        }
        timer.Start();
        await WatchServiceAsync();
    }

    private async Task TickAsync()
    {
        if (ending != 0) return;
        if (DateTimeOffset.UtcNow >= notice.ExpiresAt || permission.IsEnded) { await StopAsync("session_expired"); return; }
        if (approved || !controllerConnected) return;
        // The countdown runs only while this desktop is actually on screen (not behind the lock screen).
        if (!noticeStarted.HasValue)
        {
            if (!permission.BeginLocalAccessPolicy()) { status.Text = "Waiting for this desktop to be on screen — no sharing yet."; return; }
            noticeStarted = DateTimeOffset.UtcNow;
            approve.Enabled = true;
        }
        if (!notice.ApprovalRequired) { await DecideAsync("unattended"); return; }
        var seconds = Math.Max(0, notice.ApprovalSeconds - (int)(DateTimeOffset.UtcNow - noticeStarted.Value).TotalSeconds);
        status.Text = $"Sharing starts in {seconds} seconds unless you choose Decline.";
        if (seconds == 0) await DecideAsync("automatic");
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
        await WriteServiceAsync(new { type = "consent", approved = true, control = permission.HasControl, decision });
    }

    private void ConfigureIndicator()
    {
        if (approved && !notice.ShowSessionDetails)
        {
            // The administrator chose no indicator: hide after the configured approval; the hotkey stays registered.
            Hide();
            return;
        }
        ControlBox = false;
        ClientSize = new Size(650, 105);
        var area = (Screen.PrimaryScreen ?? Screen.AllScreens[0]).Bounds;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(area.Left + Math.Max(0, (area.Width - Width) / 2), area.Top + 5);
        heading.Text = approved ? "LIBRARY IT IS SHARING YOUR SCREEN" : "LIBRARY IT REMOTE SUPPORT — CONNECTING";
        heading.Font = new Font("Segoe UI", 12, FontStyle.Bold);
        description.SetBounds(20, 48, 610, 38);
        description.Text = notice.OperatorName + (approved ? permission.HasControl ? " — mouse and keyboard enabled" : " — view only" : " — waiting for the operator");
        status.SetBounds(20, 82, 610, 20); status.Font = new Font("Segoe UI", 9, FontStyle.Bold);
        status.Text = "End locally at any time: Ctrl + Alt + Shift + F12";
        approve.Visible = false; decline.Visible = false; allowControl.Visible = false;
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
                var message = SupportPipeMessages.Parse(line, SupportPipeMessages.ToNotice);
                if (message.Type == "controller") controllerConnected = message.Bool("connected");
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException or JsonException or InvalidDataException or InvalidOperationException) { }
        // The service or screen helper ended the session (or the service stopped).
        EndImmediately();
        if (!IsDisposed && IsHandleCreated) BeginInvoke(Close);
    }

    private async Task WriteServiceAsync(object value)
    {
        try
        {
            await serviceWriting.WaitAsync(lifetime.Token);
            try { await serviceWriter.WriteLineAsync(JsonSerializer.Serialize(value, SupportBootstrap.Json).AsMemory(), lifetime.Token); }
            finally { serviceWriting.Release(); }
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { EndImmediately(); }
    }

    private async Task StopAsync(string reason)
    {
        if (Interlocked.Exchange(ref ending, 1) != 0) return;
        permission.End();
        timer.Stop();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            await serviceWriting.WaitAsync(timeout.Token);
            try { await serviceWriter.WriteLineAsync(JsonSerializer.Serialize(new { type = "stop", reason }, SupportBootstrap.Json).AsMemory(), timeout.Token); }
            finally { serviceWriting.Release(); }
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { }
        EndImmediately();
        if (!IsDisposed && IsHandleCreated) BeginInvoke(Close);
    }

    private void EndImmediately()
    {
        if (disposed) return;
        Interlocked.Exchange(ref ending, 1);
        permission.End();
        lifetime.Cancel();
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0312 && message.WParam.ToInt32() == EmergencyHotkey) { _ = StopAsync("local_emergency_hotkey"); return; }
        base.WndProc(ref message);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            EndImmediately(); timer.Stop(); timer.Dispose();
            if (IsHandleCreated) UnregisterHotKey(Handle, EmergencyHotkey);
            lifetime.Dispose();
            disposed = true;
        }
        base.Dispose(disposing);
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
}
