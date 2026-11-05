using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LibraryRmm.Support;
using Microsoft.Win32.SafeHandles;

namespace LibraryRmm.Agent;

public sealed record SupportLaunchResult(string SessionId, string UserName, string Summary);

/// <summary>A support launch that stopped for a known reason. Messages are fixed text plus numbers only,
/// so they are safe to show operators in job output and in the support window.</summary>
public sealed class SupportLaunchException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

/// <summary>
/// Service-only launcher (agent 0.1.11+). Every session uses one SYSTEM screen helper in the target Windows session: it
/// follows that session's input desktop, so the regular desktop, Ctrl+Alt+Delete, lock, sign-in and UAC screens keep
/// streaming. When a user is signed in and the administrator's policy asks for a notice or indicator, a separate
/// non-elevated notice runs in that user's session; the service relays its decision to the screen helper.
/// The service itself never captures the screen or sends input.
/// </summary>
public static class SupportLauncher
{
    private static readonly SemaphoreSlim LaunchGate = new(1, 1);
    private static SupportLease? active;
    public static bool HasActiveSession => active is { Finished: false };

    public static async Task<SupportLaunchResult> LaunchAsync(AgentConfiguration configuration, AgentApi api, AgentJob job, CancellationToken serviceStopping)
    {
        if (!OperatingSystem.IsWindows() || !WindowsIdentity.GetCurrent().IsSystem)
            throw new InvalidOperationException("Attended support must be launched by the LocalSystem Windows service.");
        if (job.Kind != "remote_support" || !job.Payload.TryGetProperty("sessionId", out var idValue) ||
            !Guid.TryParseExact(idValue.GetString(), "D", out var id)) throw new InvalidDataException("Invalid support session job.");
        await LaunchGate.WaitAsync(serviceStopping);
        try
        {
            // A new authorized session takes over. The server ended the previous session when it created this one, so
            // whatever is still running here (stuck, abandoned, or another operator's) is closed before launching.
            var replaced = false;
            if (active is { Finished: false } previous) { await previous.TerminateAsync(); replaced = true; }
            active = null;
            var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "companion", "LibraryRmm.Support.exe"));
            if (!File.Exists(executable))
                throw new SupportLaunchException("companion_missing", "The remote support helper is not installed on this computer. Update the agent, then try again.");
            for (var directory = new DirectoryInfo(Path.GetDirectoryName(executable)!); directory is not null; directory = directory.Parent)
                if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new SupportLaunchException("companion_path_invalid", "The remote support helper's folder is a link or junction, so it was not started.");
            // Helpers left behind by a crashed or restarted service would otherwise keep a stale session alive.
            replaced |= SupportWindows.EndStrayHelpers(executable) > 0;
            using var target = SupportWindows.GetTarget();
            var noticeRequired = false;
            // One request only. A lost claim/bootstrap must not lead to relaunch or replay.
            var grant = await api.SendAsync<SupportGrant>(HttpMethod.Post, $"support/{id:D}/claim", new { jobId = job.Id }, serviceStopping)
                ?? throw new InvalidDataException("Server did not return a support grant.");
            if (grant.SessionId != id.ToString("D")) throw new InvalidDataException("Support grant does not match the authorized job.");
            noticeRequired = target.User is not null && SupportLease.NoticeRequired(grant);
            if (noticeRequired && target.User!.ElevatedOnly) throw SupportWindows.ElevatedOnly();
            var lease = await SupportLease.StartAsync(configuration, grant, target, executable, serviceStopping);
            active = lease;
            var prefix = replaced ? "The previous remote support helper on this computer was closed. " : "";
            return new SupportLaunchResult(grant.SessionId, target.User?.Name ?? "Windows sign-in screen", prefix + (target.User is null
                ? $"Nobody is signed in, so the screen helper started at the Windows sign-in screen (session {target.SessionId}). It keeps working through sign-in, lock and Ctrl+Alt+Delete screens."
                : noticeRequired
                    ? $"Screen helper started in {target.User.Name}'s Windows session {target.SessionId}; their desktop is shown only after the notice on it is approved or its countdown ends. Lock, Ctrl+Alt+Delete and UAC screens are supported."
                    : $"Screen helper started in {target.User.Name}'s Windows session {target.SessionId} without a notice or indicator, as configured. Lock, Ctrl+Alt+Delete and UAC screens are supported."));
        }
        finally { LaunchGate.Release(); }
    }

    /// <summary>Explains a helper that started but never completed the bootstrap, using its exit code when it already ended.</summary>
    internal static SupportLaunchException HandshakeFailureFor(Process process, Exception inner)
    {
        int? exitCode = null;
        try { if (process.WaitForExit(500)) exitCode = process.ExitCode; } catch (Exception exception) when (exception is InvalidOperationException or Win32Exception) { }
        return HandshakeFailure(exitCode, inner);
    }
    internal static SupportLaunchException HandshakeFailure(int? exitCode, Exception? inner) => exitCode switch
    {
        null => new("helper_no_response", "The remote support helper started but did not connect to the agent within 20 seconds.", inner),
        var code => new("helper_failed", $"The remote support helper started but exited before connecting to the agent (exit code {code}). The Windows session may be signing out or blocking the helper.", inner)
    };

    internal static void TryEndProcess(Process process)
    {
        try { if (!process.HasExited) process.Kill(); } catch (Exception exception) when (exception is InvalidOperationException or Win32Exception) { }
    }
}

/// <summary>One helper process and its bootstrap pipe. Lines are written one at a time.</summary>
internal sealed class HelperChannel : IDisposable
{
    private readonly SemaphoreSlim writing = new(1, 1);
    private HelperChannel(NamedPipeServerStream pipe, StreamReader reader, StreamWriter writer, Process process)
    { Pipe = pipe; Reader = reader; Writer = writer; Process = process; }
    public NamedPipeServerStream Pipe { get; }
    public StreamReader Reader { get; }
    public StreamWriter Writer { get; }
    public Process Process { get; }

    public static async Task<HelperChannel> StartAsync(SafeAccessTokenHandle token, string executable, string mode, string pipeSid, string desktop, string bootstrapJson, CancellationToken serviceStopping)
    {
        var pipeName = "LibraryRmm.Support." + Guid.NewGuid().ToString("N");
        NamedPipeServerStream? pipe = null;
        Process? process = null;
        try
        {
            pipe = SupportWindows.CreateBootstrapPipe(pipeName, pipeSid);
            process = SupportWindows.LaunchHelper(token, executable, pipeName, Environment.ProcessId, desktop, mode);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(serviceStopping);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                await pipe.WaitForConnectionAsync(timeout.Token);
                if (!SupportWindows.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var connectedPid) || connectedPid != process.Id)
                    throw new InvalidDataException("Support bootstrap pipe connected to an unexpected process.");
                var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
                var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
                var hello = await SupportPipeFraming.ReadLineAsync(reader, 64, timeout.Token);
                if (hello != "LIBRARY-RMM-SUPPORT/1") throw new InvalidDataException("Support companion handshake failed.");
                await writer.WriteLineAsync(bootstrapJson.AsMemory(), timeout.Token);
                if (await SupportPipeFraming.ReadLineAsync(reader, 64, timeout.Token) != "BOOTSTRAP-RECEIVED") throw new InvalidDataException("Support companion did not confirm bootstrap.");
                return new HelperChannel(pipe, reader, writer, process);
            }
            catch (Exception exception) when (!serviceStopping.IsCancellationRequested &&
                exception is OperationCanceledException or IOException or InvalidDataException or ObjectDisposedException)
            {
                throw SupportLauncher.HandshakeFailureFor(process, exception);
            }
        }
        catch
        {
            pipe?.Dispose();
            if (process is not null) { SupportLauncher.TryEndProcess(process); process.Dispose(); }
            throw;
        }
    }

    public bool Exited { get { try { return Process.HasExited; } catch (InvalidOperationException) { return true; } } }

    public async Task<bool> TryWriteAsync(string line, CancellationToken ct)
    {
        try
        {
            await writing.WaitAsync(ct);
            try { await Writer.WriteLineAsync(line.AsMemory(), ct); return true; }
            finally { writing.Release(); }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException or InvalidOperationException) { return false; }
    }

    public void Kill() { try { Pipe.Dispose(); } catch (IOException) { } SupportLauncher.TryEndProcess(Process); }

    public void Dispose()
    {
        Kill();
        try { Reader.Dispose(); Writer.Dispose(); } catch (IOException) { }
        Process.Dispose();
    }
}

/// <summary>The live helpers of one support session and the service's relay between them.</summary>
internal sealed class SupportLease
{
    private readonly SupportGrant grant;
    private readonly int sessionId;
    private readonly string executable;
    private readonly HelperChannel engine;
    private readonly CancellationTokenSource lifetime;
    private readonly object sync = new();
    private readonly SupportSecureAttentionPolicy attentionPolicy;
    private HelperChannel? notice;
    private SafeAccessTokenHandle? userToken;
    private string? userName;
    private bool controllerConnected;
    private bool launchingNotice;
    private int noticeLaunches;
    private DateTimeOffset lastNoticeLaunch = DateTimeOffset.MinValue;
    private Task? monitor;
    private int finished;

    private SupportLease(SupportGrant grant, int sessionId, string executable, HelperChannel engine, CancellationToken serviceStopping)
    {
        this.grant = grant; this.sessionId = sessionId; this.executable = executable; this.engine = engine;
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(serviceStopping);
        attentionPolicy = new SupportSecureAttentionPolicy(grant.RequestedControl);
    }

    public bool Finished => Volatile.Read(ref finished) != 0;
    public static bool NoticeRequired(SupportGrant grant) => grant.ApprovalRequired || grant.ShowSessionDetails;

    public static async Task<SupportLease> StartAsync(AgentConfiguration configuration, SupportGrant grant, SupportTarget target, string executable, CancellationToken serviceStopping)
    {
        var bootstrap = new SupportBootstrap(configuration.ServerUrl, grant, target.SessionId, Environment.ProcessId,
            SystemHelper: true, UserPresent: target.User is not null, UserName: target.User?.Name);
        bootstrap.Validate(DateTimeOffset.UtcNow);
        HelperChannel engine;
        using (var system = SupportWindows.SystemTokenFor(target.SessionId))
            engine = await HelperChannel.StartAsync(system, executable, "engine", SupportWindows.SystemSid, "WinSta0\\Winlogon",
                JsonSerializer.Serialize(bootstrap, SupportBootstrap.Json), serviceStopping);
        var lease = new SupportLease(grant, target.SessionId, executable, engine, serviceStopping);
        try
        {
            if (target.User is { } user)
            {
                lease.AdoptUser(user);
                if (NoticeRequired(grant)) await lease.LaunchNoticeAsync(user);
            }
        }
        catch
        {
            lease.lifetime.Cancel(); engine.Dispose(); lease.userToken?.Dispose();
            throw;
        }
        lease.monitor = lease.RunAsync();
        return lease;
    }

    /// <summary>Ends this session's helpers now (a new session is taking over) and waits briefly for cleanup.</summary>
    public async Task TerminateAsync()
    {
        lifetime.Cancel();
        engine.Kill();
        lock (sync) notice?.Kill();
        if (monitor is not null)
            try { await monitor.WaitAsync(TimeSpan.FromSeconds(5)); } catch (TimeoutException) { }
    }

    private void AdoptUser(SupportTarget.SessionUser user)
    {
        // Ctrl+Alt+Delete is requested as the signed-in user (limited token), or directly by the service when nobody is signed in.
        var copy = user.ElevatedOnly ? null : SupportWindows.DuplicateUserToken(user.Token);
        lock (sync) { userToken?.Dispose(); userToken = copy; userName = user.Name; }
    }

    private async Task LaunchNoticeAsync(SupportTarget.SessionUser user)
    {
        if (user.ElevatedOnly) throw SupportWindows.ElevatedOnly();
        var bootstrap = SupportNoticeBootstrap.From(grant, sessionId, Environment.ProcessId);
        bootstrap.Validate(DateTimeOffset.UtcNow);
        var channel = await HelperChannel.StartAsync(user.Token, executable, "notice", user.Sid, "WinSta0\\Default",
            JsonSerializer.Serialize(bootstrap, SupportBootstrap.Json), lifetime.Token);
        bool connected;
        lock (sync)
        {
            if (lifetime.IsCancellationRequested) { channel.Dispose(); return; }
            notice?.Dispose(); notice = channel; connected = controllerConnected;
        }
        await engine.TryWriteAsync(JsonSerializer.Serialize(new { type = "notice", pid = channel.Process.Id }), lifetime.Token);
        await channel.TryWriteAsync(JsonSerializer.Serialize(new { type = "controller", connected }), lifetime.Token);
        _ = ReadNoticeAsync(channel);
    }

    private async Task RunAsync()
    {
        using var expiry = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        expiry.CancelAfter(grant.ExpiresAt > DateTimeOffset.UtcNow ? grant.ExpiresAt - DateTimeOffset.UtcNow : TimeSpan.Zero);
        Task? requests = null;
        try
        {
            var exit = engine.Process.WaitForExitAsync(expiry.Token);
            requests = ReadEngineAsync(expiry.Token);
            while (!exit.IsCompleted)
            {
                if (!await engine.TryWriteAsync("SERVICE-ALIVE", expiry.Token)) break;
                HelperChannel? current; lock (sync) current = notice;
                if (current is not null) await current.TryWriteAsync("SERVICE-ALIVE", expiry.Token);
                var completed = await Task.WhenAny(exit, requests, Task.Delay(TimeSpan.FromSeconds(2), expiry.Token));
                if (completed == exit || completed == requests) break;
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException) { }
        finally
        {
            lifetime.Cancel();
            engine.Kill();
            if (requests is not null)
                try { await requests.WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception exception) when (exception is OperationCanceledException or TimeoutException or ObjectDisposedException) { }
            lock (sync) { notice?.Dispose(); notice = null; userToken?.Dispose(); userToken = null; }
            engine.Dispose();
            Volatile.Write(ref finished, 1);
        }
    }

    private async Task ReadEngineAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var line = await SupportPipeFraming.ReadLineAsync(engine.Reader, SupportPipeMessages.MaximumLine, ct);
                if (line is null) return;
                var message = SupportPipeMessages.Parse(line, SupportPipeMessages.FromEngine);
                switch (message.Type)
                {
                    case "secureAttention":
                    {
                        var requestId = message.Text("requestId");
                        (bool Success, string Message) result = (false, "not_available");
                        if (DateTimeOffset.UtcNow < grant.ExpiresAt && attentionPolicy.TryBegin(requestId, DateTimeOffset.UtcNow))
                            lock (sync) result = SupportSecureAttention.Request(userToken);
                        await engine.TryWriteAsync(JsonSerializer.Serialize(new { type = "secureAttentionResult", requestId, success = result.Success, message = result.Message }), ct);
                        break;
                    }
                    case "controller":
                    {
                        HelperChannel? current;
                        lock (sync) { controllerConnected = message.Bool("connected"); current = notice; }
                        if (current is not null) await current.TryWriteAsync(JsonSerializer.Serialize(new { type = "controller", connected = message.Bool("connected") }), ct);
                        break;
                    }
                    case "needNotice":
                        // Someone signed in during a sign-in/lock screen session. The screen helper repeats this while it waits.
                        StartNoticeForSignedInUser();
                        break;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or InvalidDataException or JsonException or ObjectDisposedException) { }
    }

    private void StartNoticeForSignedInUser()
    {
        lock (sync)
        {
            if (!NoticeRequired(grant) || launchingNotice || (notice is not null && !notice.Exited) || noticeLaunches >= 10 ||
                DateTimeOffset.UtcNow - lastNoticeLaunch < TimeSpan.FromSeconds(3)) return;
            launchingNotice = true; noticeLaunches++; lastNoticeLaunch = DateTimeOffset.UtcNow;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                // Right after sign-in Windows may not have a token yet; the helper asks again in a few seconds.
                using var user = SupportWindows.TryGetUser(sessionId);
                if (user is null || user.ElevatedOnly) return;
                AdoptUser(user);
                await LaunchNoticeAsync(user);
            }
            catch (Exception exception) when (exception is SupportLaunchException or Win32Exception or IOException or InvalidDataException or OperationCanceledException or InvalidOperationException) { }
            finally { lock (sync) launchingNotice = false; }
        });
    }

    private async Task ReadNoticeAsync(HelperChannel channel)
    {
        var ct = lifetime.Token;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var line = await SupportPipeFraming.ReadLineAsync(channel.Reader, SupportPipeMessages.MaximumLine, ct);
                if (line is null) return;
                var message = SupportPipeMessages.Parse(line, SupportPipeMessages.FromNotice);
                if (message.Type == "consent")
                {
                    var decision = message.Text("decision");
                    if (!SupportPipeMessages.Decisions.Contains(decision) || (decision == "unattended" && grant.ApprovalRequired)) return;
                    string name; lock (sync) name = userName ?? "Signed-in user";
                    await engine.TryWriteAsync(JsonSerializer.Serialize(new
                    {
                        type = "userConsent", approved = message.Bool("approved"), control = message.Bool("control") && grant.RequestedControl, decision, userName = name
                    }), ct);
                    if (!message.Bool("approved")) return;
                }
                else
                {
                    var reason = message.Text("reason");
                    await engine.TryWriteAsync(JsonSerializer.Serialize(new { type = "stop", reason = SupportPipeMessages.NoticeStopReasons.Contains(reason) ? reason : "staff_closed" }), ct);
                    return;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or InvalidDataException or JsonException or ObjectDisposedException) { }
        finally
        {
            bool current;
            lock (sync) { current = ReferenceEquals(notice, channel); if (current) notice = null; }
            channel.Dispose();
            // The indicator and the person's ability to decline are gone, so the screen helper must not keep sharing their desktop.
            if (current && !ct.IsCancellationRequested) await engine.TryWriteAsync("{\"type\":\"noticeClosed\"}", ct);
        }
    }
}

/// <summary>The Windows session support targets, and its signed-in user when there is one.</summary>
internal sealed class SupportTarget(int sessionId, SupportTarget.SessionUser? user) : IDisposable
{
    public int SessionId { get; } = sessionId;
    public SessionUser? User { get; } = user;
    /// <param name="ElevatedOnly">The user has only an elevated administrator token (UAC may be off); no notice is started with it.</param>
    internal sealed record SessionUser(int SessionId, string Sid, string Name, SafeAccessTokenHandle Token, bool ElevatedOnly) : IDisposable
    { public void Dispose() => Token.Dispose(); }
    public void Dispose() => User?.Dispose();
}

internal static class SupportWindows
{
    internal const string SystemSid = "S-1-5-18";

    /// <summary>The console session (or the only active session when nobody uses the console), and who is signed in to it.</summary>
    public static SupportTarget GetTarget()
    {
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var memory, out var count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int selected;
        try
        {
            var sessions = new List<int>();
            var states = new Dictionary<int, int>();
            var size = Marshal.SizeOf<WtsSession>();
            for (var i = 0; i < count; i++)
            {
                var session = Marshal.PtrToStructure<WtsSession>(memory + i * size);
                states[session.Id] = session.State;
                if (session.State == 0 && session.Id > 0) sessions.Add(session.Id);
            }
            var console = unchecked((int)WTSGetActiveConsoleSessionId());
            int? consoleState = states.TryGetValue(console, out var knownState) ? knownState : null;
            try { selected = SelectSession(sessions, console, consoleState); }
            // Nobody is signed in: show the console's sign-in screen.
            catch (SupportLaunchException exception) when (exception.Code == "no_signed_in_user" && console > 0) { selected = console; }
        }
        finally { WTSFreeMemory(memory); }
        return new SupportTarget(selected, TryGetUser(selected));
    }

    /// <summary>The signed-in user of a session with their limited token, or null when nobody is signed in to it.</summary>
    public static SupportTarget.SessionUser? TryGetUser(int sessionId)
    {
        if (!WTSQueryUserToken((uint)sessionId, out var token))
        {
            var error = Marshal.GetLastWin32Error();
            // ERROR_NO_TOKEN: the session exists but nobody is signed in to it (sign-in screen).
            if (error == 1008) return null;
            throw new SupportLaunchException("user_token_unavailable", $"Windows did not provide the signed-in user's token for session {sessionId} (Windows error {error}).");
        }
        try
        {
            // WTS normally supplies the user's limited token. Use its linked LIMITED token if an elevated
            // token was returned; the notice never runs elevated.
            if (IsElevated(token))
            {
                try { var linked = GetLinkedToken(token); token.Dispose(); token = linked; }
                catch (SupportLaunchException) { }
            }
            var elevatedOnly = IsElevated(token);
            if (!DuplicateTokenEx(token, 0x000f01ff, IntPtr.Zero, 2, 1, out var primary)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                using var identity = new WindowsIdentity(primary.DangerousGetHandle());
                return new SupportTarget.SessionUser(sessionId, identity.User?.Value ?? throw new InvalidOperationException("Interactive user's SID is unavailable."), identity.Name, primary, elevatedOnly);
            }
            catch { primary.Dispose(); throw; }
        }
        finally { token.Dispose(); }
    }

    /// <summary>A copy of this service's LocalSystem token moved into the target session. Only the fixed,
    /// SYSTEM/Admin-protected helper executable is ever started with it, and that helper opens no windows.</summary>
    internal static SafeAccessTokenHandle SystemTokenFor(int sessionId)
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out var own))
            throw new SupportLaunchException("system_helper_unavailable", $"Windows did not provide the service token for the screen helper (Windows error {Marshal.GetLastWin32Error()}).");
        try
        {
            if (!DuplicateTokenEx(own, 0x000f01ff, IntPtr.Zero, 2, 1, out var primary))
                throw new SupportLaunchException("system_helper_unavailable", $"Windows could not copy the service token for the screen helper (Windows error {Marshal.GetLastWin32Error()}).");
            var session = sessionId;
            if (!SetTokenInformation(primary, 12, ref session, sizeof(int)))
            {
                var error = Marshal.GetLastWin32Error();
                primary.Dispose();
                throw new SupportLaunchException("system_helper_unavailable", $"Windows did not allow the screen helper to run in Windows session {sessionId} (Windows error {error}).");
            }
            return primary;
        }
        finally { own.Dispose(); }
    }

    /// <summary>Ends support helpers started from this installation that no live session owns. Returns how many were ended.</summary>
    public static int EndStrayHelpers(string executable)
    {
        var ended = 0;
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
            using (process)
            {
                try
                {
                    if (!string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill();
                    process.WaitForExit(3000);
                    ended++;
                }
                catch (Exception exception) when (exception is InvalidOperationException or Win32Exception or NotSupportedException) { }
            }
        return ended;
    }

    /// <summary>Prefers the physical console; otherwise only an unambiguous single active session.</summary>
    internal static int SelectSession(IReadOnlyCollection<int> activeSessions, int consoleSession, int? consoleState)
    {
        if (activeSessions.Contains(consoleSession)) return consoleSession;
        if (activeSessions.Count == 1) return activeSessions.First();
        throw activeSessions.Count == 0
            ? new SupportLaunchException("no_signed_in_user", NoUserMessage(0, consoleSession, consoleState))
            : new SupportLaunchException("multiple_users", $"{activeSessions.Count} users have active Windows sessions and none of them is at the physical console, so remote support cannot tell whose desktop to show.");
    }
    internal static string NoUserMessage(int activeSessions, int consoleSession, int? consoleState) =>
        "No one is signed in to this computer's desktop right now" + (consoleState switch
        {
            null => consoleSession == -1 ? " (no console session is attached)." : ".",
            0 or 1 => " (the console is at the Windows sign-in screen).",
            4 => " (the console session is disconnected).",
            _ => $" (console session state {consoleState})."
        }) + " Remote support needs a Windows session attached to the console to show its screen." +
        (activeSessions == 0 ? "" : $" Active sessions found: {activeSessions}.");
    internal static SupportLaunchException ElevatedOnly() => new("limited_token_unavailable",
        "The signed-in user only has an elevated administrator token (User Account Control may be turned off), so the support notice cannot be shown. Turn off the approval notice and indicator for this computer's support policy, or turn User Account Control on.");

    private static bool IsElevated(SafeAccessTokenHandle token)
    {
        var buffer = Marshal.AllocHGlobal(4);
        try
        {
            if (!GetTokenInformation(token, 20, buffer, 4, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.ReadInt32(buffer) != 0;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static SafeAccessTokenHandle GetLinkedToken(SafeAccessTokenHandle token)
    {
        var buffer = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            if (!GetTokenInformation(token, 19, buffer, IntPtr.Size, out _)) throw ElevatedOnly();
            return new SafeAccessTokenHandle(Marshal.ReadIntPtr(buffer));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public static SafeAccessTokenHandle DuplicateUserToken(SafeAccessTokenHandle token) =>
        DuplicateTokenEx(token, 0x000f01ff, IntPtr.Zero, 2, 1, out var copy) ? copy : throw new Win32Exception(Marshal.GetLastWin32Error());
    public static NamedPipeServerStream CreateBootstrapPipe(string name, string sid)
    {
        var acl = sid == SystemSid ? "D:P(A;;GA;;;SY)" : $"D:P(A;;GA;;;SY)(A;;GA;;;{sid})";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(acl, 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateNamedPipe("\\\\.\\pipe\\" + name, 0x40080003, 0x8, 1, 8192, 8192, 0, ref security);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { LocalFree(descriptor); }
    }
    public static Process LaunchHelper(SafeAccessTokenHandle token, string executable, string pipe, int servicePid, string desktop, string mode)
    {
        if (desktop is not ("WinSta0\\Default" or "WinSta0\\Winlogon")) throw new ArgumentOutOfRangeException(nameof(desktop));
        if (mode is not ("engine" or "notice")) throw new ArgumentOutOfRangeException(nameof(mode));
        if (!CreateEnvironmentBlock(out var environment, token, false))
            throw new SupportLaunchException("helper_start_failed", $"Windows could not prepare the environment for the remote support helper (Windows error {Marshal.GetLastWin32Error()}).");
        try
        {
            var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Desktop = desktop, ShowWindow = 1, Flags = 1 };
            var command = new StringBuilder($"\"{executable}\" --pipe {pipe} --service-pid {servicePid} --mode {mode}");
            // CREATE_UNICODE_ENVIRONMENT; the screen helper also gets ABOVE_NORMAL priority so capture and input stay responsive.
            var flags = 0x400u | (mode == "engine" ? 0x8000u : 0u);
            if (!CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, false, flags, environment,
                Path.GetDirectoryName(executable), ref startup, out var info))
                throw new SupportLaunchException("helper_start_failed", $"Windows could not start the remote support helper (Windows error {Marshal.GetLastWin32Error()}).");
            try { return Process.GetProcessById(info.ProcessId); }
            finally { CloseHandle(info.Process); CloseHandle(info.Thread); }
        }
        finally { DestroyEnvironmentBlock(environment); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct WtsSession { public int Id; public IntPtr Name; public int State; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size; public string? Reserved; public string? Desktop; public string? Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags; public short ShowWindow, Reserved2;
        public IntPtr ReservedPointer, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr pointer);
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQueryUserToken(uint sessionId, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind, IntPtr information, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(SafeAccessTokenHandle token, uint access, IntPtr security, int impersonation, int tokenType, out SafeAccessTokenHandle primary);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out int processId);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out IntPtr environment, SafeAccessTokenHandle token, bool inherit);
    [DllImport("userenv.dll")] private static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessAsUser(SafeAccessTokenHandle token, string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInformation information);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(SafeAccessTokenHandle token, int kind, ref int information, int length);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
