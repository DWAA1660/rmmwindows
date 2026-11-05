using System.Text.Json;
using LibraryRmm.Support;

namespace LibraryRmm.Support;

/// <summary>Pure tests: no desktop capture, SendInput, WTS launch, service changes or network.</summary>
public static class SupportSelfTests
{
    public static async Task RunAsync()
    {
        var now = DateTimeOffset.UtcNow;
        var bootstrap = new SupportBootstrap("https://rmm.example.test", new SupportGrant(Guid.NewGuid().ToString("D"), "test.operator", now.AddMinutes(20), true, new string('t', 43)), 1, 123);
        var relay = bootstrap.Validate(now);
        Assert(relay.Scheme == "wss" && relay.Host == "rmm.example.test" && relay.Query.Length == 0, "Relay credential/origin isolation failed.");
        foreach (var origin in new[] { "http://rmm.example.test", "https://user:secret@rmm.example.test", "https://rmm.example.test/foreign", "https://rmm.example.test?x=1" })
            Reject(() => (bootstrap with { ServerOrigin = origin }).Validate(now));
        Reject(() => (bootstrap with { Grant = bootstrap.Grant with { ExpiresAt = now.AddHours(2) } }).Validate(now));
        Reject(() => (bootstrap with { Grant = bootstrap.Grant with { Credential = "short" } }).Validate(now));
        Reject(() => (bootstrap with { Grant = bootstrap.Grant with { ApprovalSeconds = 0 } }).Validate(now));
        Reject(() => (bootstrap with { Grant = bootstrap.Grant with { ApprovalSeconds = 301 } }).Validate(now));
        (bootstrap with { Grant = bootstrap.Grant with { ApprovalRequired = false, ShowSessionDetails = false } }).Validate(now);
        var desktop = true;
        var captures = 0; var inputs = 0;
        var gate = new SupportPermissionGate(bootstrap, () => now, () => desktop);
        Assert(!gate.TryCapture(() => captures++) && !gate.TryInput(() => inputs++), "Access occurred without consent.");
        Assert(gate.ApproveLocally(false) && gate.TryCapture(() => captures++), "Viewing permission failed.");
        Assert(!gate.TryInput(() => inputs++), "View-only consent enabled input.");
        desktop = false;
        Assert(!gate.TryCapture(() => captures++) && gate.IsPaused, "Secure/locked desktop was not refused.");
        desktop = true;
        Assert(!gate.TryCapture(() => captures++), "Sharing silently resumed after desktop change.");
        Assert(gate.ResumeLocally() && gate.TryCapture(() => captures++), "Local resume failed.");
        gate.End();
        Assert(!gate.TryCapture(() => captures++) && !gate.TryInput(() => inputs++) && !gate.ApproveLocally(true) && !gate.ResumeLocally(), "Stopped session was revived.");
        Assert(captures == 2 && inputs == 0, "Unexpected side-effect count.");
        var controlGate = new SupportPermissionGate(bootstrap, () => now, () => true);
        Assert(controlGate.ApproveLocally(true) && controlGate.TryInput(() => inputs++), "Approved control refused.");
        now = bootstrap.Grant.ExpiresAt;
        Assert(!controlGate.TryInput(() => inputs++) && controlGate.IsEnded, "Expired session accepted input.");
        var viewGrant = bootstrap with { Grant = bootstrap.Grant with { RequestedControl = false } };
        var viewGate = new SupportPermissionGate(viewGrant, () => now.AddMinutes(-10), () => true);
        Assert(viewGate.ApproveLocally(true) && !viewGate.TryInput(() => inputs++), "Local approval exceeded requested privilege.");
        foreach (var invalid in new[] {
            "{\"type\":\"input\",\"action\":\"execute\"}", "{\"type\":\"input\",\"action\":\"move\",\"x\":2,\"y\":0}",
            "{\"type\":\"input\",\"action\":\"keyDown\",\"key\":\"RunCommand\"}", "{\"type\":\"input\",\"action\":\"wheel\",\"deltaY\":1201}",
            "{\"type\":\"input\",\"action\":\"down\",\"button\":4}", "{\"type\":\"input\",\"action\":\"move\",\"x\":0}"
        }) Reject(() => SupportInput.Parse(JsonDocument.Parse(invalid).RootElement));
        var move = SupportInput.Parse(JsonSerializer.SerializeToElement(new { type = "input", action = "move", x = 0.5, y = 1 }));
        Assert(move.X == 0.5 && move.Y == 1, "Valid normalized input rejected.");
        Assert(SupportInput.Keys.ContainsKey("KeyA") && SupportInput.Keys.ContainsKey("NumpadEnter") && !SupportInput.Keys.ContainsKey("Unidentified"), "Key policy failed.");
        now = bootstrap.Grant.ExpiresAt.AddMinutes(-10);
        var countdown = new SupportPermissionGate(bootstrap, () => now, () => desktop);
        Assert(!countdown.ApproveAfterVisibleCountdown(true), "Countdown auto-approved without a visible notice.");
        Assert(countdown.BeginLocalAccessPolicy(), "Visible notice did not start countdown.");
        now = now.AddSeconds(14);
        Assert(!countdown.ApproveAfterVisibleCountdown(true) && !countdown.TryCapture(() => captures++), "Screen access occurred before 15 seconds.");
        now = now.AddSeconds(1);
        Assert(countdown.ApproveAfterVisibleCountdown(true) && countdown.TryInput(() => inputs++), "15-second notice policy did not enable requested mode.");
        countdown.End(); // Same irreversible gate used by the local emergency hotkey.
        Assert(!countdown.TryCapture(() => captures++) && !countdown.TryInput(() => inputs++) && !countdown.ResumeLocally(), "Emergency end was revived.");
        var declined = new SupportPermissionGate(bootstrap, () => now, () => true);
        Assert(declined.BeginLocalAccessPolicy(), "Decline test notice failed.");
        declined.End(); now = now.AddSeconds(20);
        Assert(!declined.ApproveAfterVisibleCountdown(true), "Declined notice later auto-approved.");
        desktop = false;
        var hidden = new SupportPermissionGate(bootstrap, () => now, () => desktop);
        Assert(!hidden.BeginLocalAccessPolicy(), "A hidden/secure desktop started a countdown.");
        desktop = true;
        var unattendedGrant = bootstrap with { Grant = bootstrap.Grant with { ApprovalRequired = false } };
        var unattended = new SupportPermissionGate(unattendedGrant, () => now, () => desktop);
        Assert(!unattended.ApproveImmediatePolicy(true) && !unattended.TryCapture(() => captures++), "No-prompt policy bypassed local readiness.");
        Assert(unattended.BeginLocalAccessPolicy() && unattended.ApproveImmediatePolicy(true), "Configured immediate policy failed after local readiness.");
        Assert(unattended.TryInput(() => inputs++), "Configured control was not enabled after local readiness.");
        unattended.End();
        Assert(!unattended.TryCapture(() => captures++), "No-prompt policy bypassed emergency end.");
        var configured = bootstrap with { Grant = bootstrap.Grant with { ApprovalSeconds = 30 } };
        var configuredGate = new SupportPermissionGate(configured, () => now, () => true);
        Assert(configuredGate.BeginLocalAccessPolicy(), "Configured countdown failed.");
        now = now.AddSeconds(15);
        Assert(!configuredGate.ApproveAfterVisibleCountdown(true), "Configured countdown ignored its interval.");
        now = now.AddSeconds(15);
        Assert(configuredGate.ApproveAfterVisibleCountdown(true), "Configured countdown never completed.");
        var ready = false;
        var readiness = new SupportPermissionGate(bootstrap, () => now, () => true, () => ready);
        Assert(readiness.ApproveLocally(true) && !readiness.TryCapture(() => captures++) && !readiness.TryInput(() => inputs++), "Unready browser received access.");
        ready = true;
        Assert(readiness.TryCapture(() => captures++), "Ready controller could not receive an authorized frame.");
        ready = false;
        Assert(!readiness.TryInput(() => inputs++), "Disconnected controller still had input access.");
        var oldGrant = JsonSerializer.Deserialize<SupportGrant>(JsonSerializer.Serialize(new
        {
            sessionId = bootstrap.Grant.SessionId, operatorName = "test.operator", expiresAt = bootstrap.Grant.ExpiresAt,
            requestedControl = true, credential = new string('t', 43)
        }), SupportBootstrap.Json)!;
        Assert(oldGrant.ApprovalRequired && oldGrant.ApprovalSeconds == 15 && oldGrant.ShowSessionDetails, "Backward-compatible policy defaults changed.");
        var leftMonitor = new SupportDisplayGeometry("left", -1920, 0, 1920, 1080);
        Assert(leftMonitor.MapNormalized(0, 0) == (-1920, 0) && leftMonitor.MapNormalized(1, 1) == (-1, 1079), "Left monitor mapping crossed into another screen.");
        var upperMonitor = new SupportDisplayGeometry("above", 200, -1200, 2560, 1200);
        Assert(upperMonitor.MapNormalized(0, 0) == (200, -1200) && upperMonitor.MapNormalized(1, 1) == (2759, -1), "Upper/scaled monitor mapping failed.");
        Reject(() => leftMonitor.MapNormalized(1.01, 0));
        using (var inputStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes("HELLO\r\n")))
        using (var reader = new StreamReader(inputStream))
            Assert(await SupportPipeFraming.ReadLineAsync(reader, 5, CancellationToken.None) == "HELLO", "Pipe framing changed a valid message.");
        foreach (var invalidLine in new[] { "123456789\n", "HELLOx\n", "HELLO\r\r\n", "partial" })
        {
            using var inputStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(invalidLine));
            using var reader = new StreamReader(inputStream);
            var rejected = false;
            try { await SupportPipeFraming.ReadLineAsync(reader, 5, CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
            Assert(rejected, "Oversized/incomplete pipe frame accepted.");
        }
        Console.WriteLine("PASS attended-support policy/countdown, controller readiness, end/expiry, desktop/input and bounded-pipe checks (no capture or input performed)");
    }
    private static void Assert(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private static void Reject(Action action)
    {
        try { action(); } catch (InvalidDataException) { return; }
        throw new InvalidOperationException("Unsafe support input/bootstrap accepted.");
    }
}
