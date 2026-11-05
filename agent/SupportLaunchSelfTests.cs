namespace LibraryRmm.Agent;

/// <summary>Pure tests for support launch session selection and its operator-facing failure reasons. No WTS or process calls.</summary>
public static class SupportLaunchSelfTests
{
    public static Task RunAsync()
    {
        Check(SupportWindows.SelectSession([1, 3], 1, 0) == 1, "Console session was not preferred.");
        Check(SupportWindows.SelectSession([3], 1, 1) == 3, "The only active session was not selected.");
        var none = Fails(() => SupportWindows.SelectSession([], 1, 1));
        Check(none.Code == "no_signed_in_user" && none.Message.Contains("sign-in screen") && none.Message.Contains("signed-in Windows desktop"),
            "No-user failure did not explain the sign-in screen.");
        Check(Fails(() => SupportWindows.SelectSession([], 1, 4)).Message.Contains("disconnected"), "Disconnected console was not explained.");
        Check(Fails(() => SupportWindows.SelectSession([], -1, null)).Message.Contains("no console session"), "Missing console was not explained.");
        var many = Fails(() => SupportWindows.SelectSession([2, 3], 1, 1));
        Check(many.Code == "multiple_users" && many.Message.StartsWith("2 users"), "Ambiguous sessions were not explained.");
        var exited = SupportLauncher.HandshakeFailure(10, null);
        Check(exited.Code == "helper_failed" && exited.Message.Contains("exit code 10"), "Helper exit code was not reported.");
        Check(SupportLauncher.HandshakeFailure(null, null).Code == "helper_no_response", "Unresponsive helper was not reported.");
        foreach (var message in new[] { none.Message, many.Message, exited.Message })
            Check(message.Length < 400 && !message.Any(char.IsControl), "Launch failure text must be short single-line text.");

        // Sign-in screen sessions follow the console's input desktop.
        var attended = new LibraryRmm.Support.SupportGrant(Guid.NewGuid().ToString("D"), "admin", DateTimeOffset.UtcNow.AddMinutes(20), true, new string('t', 43));
        var unattended = attended with { ApprovalRequired = false, ShowSessionDetails = false };
        var noticeOnly = attended with { ApprovalRequired = false, ShowSessionDetails = true };
        var Step = (Func<string?, bool, LibraryRmm.Support.SupportGrant, LibraryRmm.Support.SignInScreenPolicy.Step>)LibraryRmm.Support.SignInScreenPolicy.Decide;
        Check(Step(null, false, attended) == LibraryRmm.Support.SignInScreenPolicy.Step.Wait, "Detached console must wait.");
        Check(Step("Winlogon", false, attended) == LibraryRmm.Support.SignInScreenPolicy.Step.Continue, "Sign-in screen must be shown.");
        Check(Step("Winlogon", true, attended) == LibraryRmm.Support.SignInScreenPolicy.Step.Continue, "Lock/Ctrl+Alt+Delete screen must be shown.");
        Check(Step("Default", false, attended) == LibraryRmm.Support.SignInScreenPolicy.Step.Continue, "Desktop without a user must be shown.");
        Check(Step("Default", true, attended) == LibraryRmm.Support.SignInScreenPolicy.Step.EndUserSignedIn, "A signed-in desktop must end when approval is required.");
        Check(Step("default", true, noticeOnly) == LibraryRmm.Support.SignInScreenPolicy.Step.EndUserSignedIn, "A signed-in desktop must end when the indicator is required.");
        Check(Step("Default", true, unattended) == LibraryRmm.Support.SignInScreenPolicy.Step.Continue, "Unattended policy must continue after sign-in.");
        var bootstrap = new LibraryRmm.Support.SupportBootstrap("https://rmm.example.test", attended, 1, 4, SignInScreen: true);
        var json = System.Text.Json.JsonSerializer.Serialize(bootstrap, LibraryRmm.Support.SupportBootstrap.Json);
        Check(System.Text.Json.JsonSerializer.Deserialize<LibraryRmm.Support.SupportBootstrap>(json, LibraryRmm.Support.SupportBootstrap.Json)!.SignInScreen, "Sign-in mode lost in bootstrap.");
        Check(!System.Text.Json.JsonSerializer.Deserialize<LibraryRmm.Support.SupportBootstrap>(json.Replace("\"signInScreen\":true,", "").Replace(",\"signInScreen\":true", ""), LibraryRmm.Support.SupportBootstrap.Json)!.SignInScreen,
            "A bootstrap without the field must default to the signed-in user helper.");
        Console.WriteLine("PASS support launch selects the console/sole session, explains failures, and sign-in screen sessions follow the input desktop");
        return Task.CompletedTask;
    }

    private static SupportLaunchException Fails(Action action)
    {
        try { action(); }
        catch (SupportLaunchException exception) { return exception; }
        throw new InvalidOperationException("Expected a support launch failure.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
