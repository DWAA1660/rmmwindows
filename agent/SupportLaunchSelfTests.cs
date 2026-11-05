using System.Text.Json;
using LibraryRmm.Support;

namespace LibraryRmm.Agent;

/// <summary>Pure tests for support launch session selection, failure reasons, the screen helper's desktop policy and the
/// service/helper pipe messages. No WTS, process, capture or input calls.</summary>
public static class SupportLaunchSelfTests
{
    public static Task RunAsync()
    {
        Check(SupportWindows.SelectSession([1, 3], 1, 0) == 1, "Console session was not preferred.");
        Check(SupportWindows.SelectSession([3], 1, 1) == 3, "The only active session was not selected.");
        var none = Fails(() => SupportWindows.SelectSession([], 1, 1));
        Check(none.Code == "no_signed_in_user" && none.Message.Contains("sign-in screen"), "No-user failure did not explain the sign-in screen.");
        Check(Fails(() => SupportWindows.SelectSession([], 1, 4)).Message.Contains("disconnected"), "Disconnected console was not explained.");
        Check(Fails(() => SupportWindows.SelectSession([], -1, null)).Message.Contains("no console session"), "Missing console was not explained.");
        var many = Fails(() => SupportWindows.SelectSession([2, 3], 1, 1));
        Check(many.Code == "multiple_users" && many.Message.StartsWith("2 users"), "Ambiguous sessions were not explained.");
        var exited = SupportLauncher.HandshakeFailure(10, null);
        Check(exited.Code == "helper_failed" && exited.Message.Contains("exit code 10"), "Helper exit code was not reported.");
        Check(SupportLauncher.HandshakeFailure(null, null).Code == "helper_no_response", "Unresponsive helper was not reported.");
        foreach (var message in new[] { none.Message, many.Message, exited.Message, SupportWindows.ElevatedOnly().Message })
            Check(message.Length < 400 && !message.Any(char.IsControl), "Launch failure text must be short single-line text.");

        // The SYSTEM screen helper follows the input desktop: sign-in/lock/Ctrl+Alt+Delete need no consent, a signed-in
        // user's own desktop (or an unlocked UAC prompt) needs the configured notice first.
        var attended = new SupportGrant(Guid.NewGuid().ToString("D"), "admin", DateTimeOffset.UtcNow.AddMinutes(20), true, new string('t', 43));
        var unattended = attended with { ApprovalRequired = false, ShowSessionDetails = false };
        var indicatorOnly = attended with { ApprovalRequired = false, ShowSessionDetails = true };
        var Step = (Func<string?, bool, bool, bool, SupportGrant, SupportAccessPolicy.Step>)SupportAccessPolicy.Decide;
        Check(Step(null, false, false, false, attended) == SupportAccessPolicy.Step.Wait, "Detached session must wait.");
        Check(Step("Winlogon", false, false, false, attended) == SupportAccessPolicy.Step.Continue, "Sign-in screen must be shown.");
        Check(Step("Default", false, false, false, attended) == SupportAccessPolicy.Step.Continue, "Desktop without a user must be shown.");
        Check(Step("Winlogon", true, true, false, attended) == SupportAccessPolicy.Step.Continue, "Lock/Ctrl+Alt+Delete screen of a locked session must be shown.");
        Check(Step("Winlogon", true, false, false, attended) == SupportAccessPolicy.Step.NeedUserConsent, "An unlocked UAC prompt shows the user's desktop and needs consent.");
        Check(Step("Default", true, false, false, attended) == SupportAccessPolicy.Step.NeedUserConsent, "A signed-in desktop needs the notice when approval is required.");
        Check(Step("default", true, false, false, indicatorOnly) == SupportAccessPolicy.Step.NeedUserConsent, "A signed-in desktop needs the indicator first.");
        Check(Step("Default", true, false, true, attended) == SupportAccessPolicy.Step.Continue, "Consented desktop must be shown.");
        Check(Step("Winlogon", true, false, true, attended) == SupportAccessPolicy.Step.Continue, "Ctrl+Alt+Delete after consent must keep streaming.");
        Check(Step("Default", true, false, false, unattended) == SupportAccessPolicy.Step.Continue, "No-notice policy must continue after sign-in.");

        var bootstrap = new SupportBootstrap("https://rmm.example.test", attended, 1, 4, SystemHelper: true, UserPresent: true, UserName: "LIB\\staff");
        bootstrap.Validate(DateTimeOffset.UtcNow);
        var json = JsonSerializer.Serialize(bootstrap, SupportBootstrap.Json);
        var copy = JsonSerializer.Deserialize<SupportBootstrap>(json, SupportBootstrap.Json)!;
        Check(copy.SystemHelper && copy.UserPresent && copy.UserName == "LIB\\staff", "Screen helper fields lost in bootstrap.");
        Check(!bootstrap.NoNotice && (bootstrap with { Grant = unattended }).NoNotice, "No-notice policy misread.");
        Reject(() => (bootstrap with { UserName = null }).Validate(DateTimeOffset.UtcNow));
        Reject(() => (bootstrap with { UserName = "a\nb" }).Validate(DateTimeOffset.UtcNow));
        var notice = SupportNoticeBootstrap.From(attended, 1, 4);
        notice.Validate(DateTimeOffset.UtcNow);
        Check(!JsonSerializer.Serialize(notice, SupportBootstrap.Json).Contains(attended.Credential), "The notice must never receive the relay credential.");
        Reject(() => (notice with { ExpiresAt = DateTimeOffset.UtcNow.AddHours(2) }).Validate(DateTimeOffset.UtcNow));

        // Pipe messages have exact shapes; the notice cannot name the consenting user or send unknown types.
        var consent = SupportPipeMessages.Parse("{\"type\":\"consent\",\"approved\":true,\"control\":false,\"decision\":\"automatic\"}", SupportPipeMessages.FromNotice);
        Check(consent.Type == "consent" && consent.Bool("approved") && !consent.Bool("control") && consent.Text("decision") == "automatic", "Valid notice consent rejected.");
        Check(SupportPipeMessages.Parse("{\"type\":\"needNotice\"}", SupportPipeMessages.FromEngine).Type == "needNotice", "needNotice rejected.");
        Check(SupportPipeMessages.Parse("{\"type\":\"notice\",\"pid\":42}", SupportPipeMessages.ToEngine).Int("pid") == 42, "notice pid rejected.");
        foreach (var (line, shapes) in new[]
        {
            ("{\"type\":\"consent\",\"approved\":true,\"control\":false,\"decision\":\"automatic\",\"userName\":\"ADMIN\"}", SupportPipeMessages.FromNotice),
            ("{\"type\":\"consent\",\"approved\":\"yes\",\"control\":false,\"decision\":\"automatic\"}", SupportPipeMessages.FromNotice),
            ("{\"type\":\"run\",\"command\":\"x\"}", SupportPipeMessages.FromNotice),
            ("{\"type\":\"secureAttention\",\"requestId\":\"nope\"}", SupportPipeMessages.FromEngine),
            ("{\"type\":\"notice\",\"pid\":-1}", SupportPipeMessages.ToEngine),
            ("{\"type\":\"stop\",\"reason\":\"" + new string('x', 600) + "\"}", SupportPipeMessages.ToEngine),
            ("[1]", SupportPipeMessages.ToNotice)
        })
        {
            var rejected = false;
            try { SupportPipeMessages.Parse(line, shapes); } catch (Exception exception) when (exception is InvalidDataException or JsonException) { rejected = true; }
            Check(rejected, "Unsafe support pipe message accepted: " + line[..Math.Min(40, line.Length)]);
        }
        Console.WriteLine("PASS support launch selection/failure text, screen-helper desktop policy, notice bootstrap without credentials, strict pipe messages");
        return Task.CompletedTask;
    }

    private static SupportLaunchException Fails(Action action)
    {
        try { action(); }
        catch (SupportLaunchException exception) { return exception; }
        throw new InvalidOperationException("Expected a support launch failure.");
    }
    private static void Reject(Action action)
    {
        try { action(); } catch (InvalidDataException) { return; }
        throw new InvalidOperationException("Invalid support bootstrap accepted.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
