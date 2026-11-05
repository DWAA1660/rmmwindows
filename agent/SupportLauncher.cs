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

/// <summary>Service-only launcher. Never captures the desktop or supplies a service token to a user.</summary>
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
            if (active is { Finished: false }) throw new InvalidOperationException("An attended support companion is already active.");
            var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "companion", "LibraryRmm.Support.exe"));
            if (!File.Exists(executable)) throw new FileNotFoundException("The attended-support companion is not installed. Update this endpoint agent first.");
            for (var directory = new DirectoryInfo(Path.GetDirectoryName(executable)!); directory is not null; directory = directory.Parent)
                if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Support companion path traverses a reparse point.");
            using var user = SupportWindows.GetActiveUser();
            var pipeName = "LibraryRmm.Support." + Guid.NewGuid().ToString("N");
            var pipe = SupportWindows.CreateBootstrapPipe(pipeName, user.Sid);
            Process? process = null;
            try
            {
                // One request only. A lost claim/bootstrap must not lead to relaunch or replay.
                var grant = await api.SendAsync<SupportGrant>(HttpMethod.Post, $"support/{id:D}/claim", new { jobId = job.Id }, serviceStopping)
                    ?? throw new InvalidDataException("Server did not return a support grant.");
                if (grant.SessionId != id.ToString("D")) throw new InvalidDataException("Support grant does not match the authorized job.");
                var bootstrap = new SupportBootstrap(configuration.ServerUrl, grant, user.SessionId, Environment.ProcessId);
                bootstrap.Validate(DateTimeOffset.UtcNow);
                process = SupportWindows.LaunchUserProcess(user.Token, executable, pipeName, Environment.ProcessId);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(serviceStopping);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                await pipe.WaitForConnectionAsync(timeout.Token);
                if (!SupportWindows.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var connectedPid) || connectedPid != process.Id)
                    throw new InvalidDataException("Support bootstrap pipe connected to an unexpected process.");
                var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
                var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
                var hello = await SupportPipeFraming.ReadLineAsync(reader, 64, timeout.Token);
                if (hello != "LIBRARY-RMM-SUPPORT/1") throw new InvalidDataException("Support companion handshake failed.");
                await writer.WriteLineAsync(JsonSerializer.Serialize(bootstrap, SupportBootstrap.Json).AsMemory(), timeout.Token);
                if (await SupportPipeFraming.ReadLineAsync(reader, 64, timeout.Token) != "BOOTSTRAP-RECEIVED") throw new InvalidDataException("Support companion did not confirm bootstrap.");
                active = new SupportLease(pipe, reader, writer, process, grant, SupportWindows.DuplicateUserToken(user.Token), serviceStopping);
                active.Start();
                return new SupportLaunchResult(grant.SessionId, user.Name,
                    "Visible attended-support notice launched for the active user. Sharing starts only after that notice's approval/countdown policy; no desktop access was performed by the service.");
            }
            catch
            {
                pipe.Dispose();
                if (process is not null) { TryEndProcess(process); process.Dispose(); }
                throw;
            }
        }
        finally { LaunchGate.Release(); }
    }

    private static void TryEndProcess(Process process)
    {
        try { if (!process.HasExited) process.Kill(); } catch (Exception exception) when (exception is InvalidOperationException or Win32Exception) { }
    }

    private sealed class SupportLease(NamedPipeServerStream pipe, StreamReader reader, StreamWriter writer, Process process, SupportGrant grant, SafeAccessTokenHandle targetUser, CancellationToken serviceStopping)
    {
        private int finished;
        private readonly SemaphoreSlim writing = new(1, 1);
        public bool Finished => Volatile.Read(ref finished) != 0;
        public void Start() => _ = MonitorAsync();
        private async Task MonitorAsync()
        {
            using var expiry = CancellationTokenSource.CreateLinkedTokenSource(serviceStopping);
            expiry.CancelAfter(grant.ExpiresAt > DateTimeOffset.UtcNow ? grant.ExpiresAt - DateTimeOffset.UtcNow : TimeSpan.Zero);
            Task? requests = null;
            try
            {
                var exit = process.WaitForExitAsync(expiry.Token);
                requests = ReadRequestsAsync(expiry.Token);
                while (!exit.IsCompleted)
                {
                    await WriteAsync("SERVICE-ALIVE", expiry.Token);
                    var completed = await Task.WhenAny(exit, requests, Task.Delay(TimeSpan.FromSeconds(2), expiry.Token));
                    if (completed == exit || completed == requests) break;
                }
            }
            catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException) { }
            finally
            {
                expiry.Cancel();
                pipe.Dispose();
                if (requests is not null)
                    try { await requests.WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception exception) when (exception is OperationCanceledException or TimeoutException or ObjectDisposedException) { }
                TryEndProcess(process);
                reader.Dispose(); writer.Dispose(); pipe.Dispose(); process.Dispose();
                targetUser.Dispose(); writing.Dispose();
                Volatile.Write(ref finished, 1);
            }
        }
        private async Task WriteAsync(string line, CancellationToken ct)
        {
            await writing.WaitAsync(ct);
            try { await writer.WriteLineAsync(line.AsMemory(), ct); }
            finally { writing.Release(); }
        }
        private async Task ReadRequestsAsync(CancellationToken ct)
        {
            var policy = new SupportSecureAttentionPolicy(grant.RequestedControl);
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var line = await SupportPipeFraming.ReadLineAsync(reader, 512, ct);
                    if (line is null) return;
                    var requestId = SupportSecureAttentionPolicy.ParseRequest(line);
                    var result = DateTimeOffset.UtcNow < grant.ExpiresAt && policy.TryBegin(requestId, DateTimeOffset.UtcNow)
                        ? SupportSecureAttention.Request(targetUser) : (false, "not_available");
                    await WriteAsync(JsonSerializer.Serialize(new { type = "secureAttentionResult", requestId, success = result.Item1, message = result.Item2 }, SupportBootstrap.Json), ct);
                }
            }
            catch (Exception exception) when (exception is IOException or OperationCanceledException or InvalidDataException or JsonException or ObjectDisposedException) { }
        }
    }
}

internal static class SupportWindows
{
    internal sealed record ActiveUser(int SessionId, string Sid, string Name, SafeAccessTokenHandle Token) : IDisposable
    { public void Dispose() => Token.Dispose(); }

    public static ActiveUser GetActiveUser()
    {
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var memory, out var count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var sessions = new List<int>();
            var size = Marshal.SizeOf<WtsSession>();
            for (var i = 0; i < count; i++)
            {
                var session = Marshal.PtrToStructure<WtsSession>(memory + i * size);
                if (session.State == 0 && session.Id > 0) sessions.Add(session.Id);
            }
            var console = unchecked((int)WTSGetActiveConsoleSessionId());
            var selected = sessions.Contains(console) ? console : sessions.Count == 1 ? sessions[0] :
                throw new InvalidOperationException("No unique active logged-on desktop session is available.");
            if (!WTSQueryUserToken((uint)selected, out var token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                // WTS normally supplies the user's limited token. Use its linked LIMITED token
                // if an elevated token was returned; never launch an elevated support helper.
                if (IsElevated(token))
                {
                    var linked = GetLinkedToken(token);
                    token.Dispose(); token = linked;
                }
                if (IsElevated(token)) throw new InvalidOperationException("A non-elevated interactive user token is required.");
                if (!DuplicateTokenEx(token, 0x000f01ff, IntPtr.Zero, 2, 1, out var primary)) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    using var identity = new WindowsIdentity(primary.DangerousGetHandle());
                    return new ActiveUser(selected, identity.User?.Value ?? throw new InvalidOperationException("Interactive user's SID is unavailable."), identity.Name, primary);
                }
                catch { primary.Dispose(); throw; }
            }
            finally { token.Dispose(); }
        }
        finally { WTSFreeMemory(memory); }
    }

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
            if (!GetTokenInformation(token, 19, buffer, IntPtr.Size, out _)) throw new InvalidOperationException("Cannot obtain a non-elevated user token.");
            return new SafeAccessTokenHandle(Marshal.ReadIntPtr(buffer));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public static SafeAccessTokenHandle DuplicateUserToken(SafeAccessTokenHandle token) =>
        DuplicateTokenEx(token, 0x000f01ff, IntPtr.Zero, 2, 1, out var copy) ? copy : throw new Win32Exception(Marshal.GetLastWin32Error());
    public static NamedPipeServerStream CreateBootstrapPipe(string name, string sid)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor($"D:P(A;;GA;;;SY)(A;;GA;;;{sid})", 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateNamedPipe("\\\\.\\pipe\\" + name, 0x40080003, 0x8, 1, 8192, 8192, 0, ref security);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { LocalFree(descriptor); }
    }
    public static Process LaunchUserProcess(SafeAccessTokenHandle token, string executable, string pipe, int servicePid)
    {
        if (!CreateEnvironmentBlock(out var environment, token, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Desktop = "WinSta0\\Default", ShowWindow = 1, Flags = 1 };
            var command = new StringBuilder($"\"{executable}\" --pipe {pipe} --service-pid {servicePid}");
            if (!CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x400, environment,
                Path.GetDirectoryName(executable), ref startup, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error());
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
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
