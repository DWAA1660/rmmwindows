using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace LibraryRmm.Support;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.SequenceEqual(["--self-test"]))
        {
            try { SupportSelfTests.RunAsync().GetAwaiter().GetResult(); return 0; }
            catch { return 1; }
        }
        if (args.SequenceEqual(["--desktop-smoke-test"]))
        {
            // Manual developer check of the screen helper's desktop thread on the current desktop: attach, enumerate
            // monitors, encode one keyframe and one unchanged frame in memory (discarded, never sent or saved).
            using var thread = new InputDesktopThread("Smoke test");
            using var encoder = new FrameEncoder();
            var result = thread.RunAsync(() =>
            {
                var desktop = thread.Attach();
                var monitors = InputDesktopThread.Monitors();
                var watch = Stopwatch.StartNew();
                var keyframe = monitors.Count > 0 ? encoder.Next(monitors[0].Bounds, 1, keyframe: true, heartbeat: false) : null;
                var first = watch.ElapsedMilliseconds; watch.Restart();
                var unchanged = monitors.Count > 0 ? encoder.Next(monitors[0].Bounds, 2, keyframe: false, heartbeat: true) : null;
                var changed = string.Join(" ", encoder.LastRects.Select(rect => $"{rect.Width}x{rect.Height}@{rect.X},{rect.Y}"));
                return (desktop, monitors.Count, keyframe?.Length ?? 0, first, unchanged?.Length ?? 0, watch.ElapsedMilliseconds, InputDesktopThread.EmergencyKeysDown(), changed);
            }).GetAwaiter().GetResult();
            Console.WriteLine($"desktop={result.desktop} monitors={result.Item2} keyframeBytes={result.Item3} keyframeMs={result.first} nextFrameBytes={result.Item5} nextFrameMs={result.Item6} emergencyKeysDown={result.Item7} changed=[{result.changed}]");
            return result.desktop is not null && result.Item2 > 0 && result.Item3 > 0 && !result.Item7 ? 0 : 1;
        }
        try
        {
            if (args.Length != 6 || args[0] != "--pipe" || args[2] != "--service-pid" || args[4] != "--mode" || args[5] is not ("engine" or "notice") ||
                !args[1].StartsWith("LibraryRmm.Support.", StringComparison.Ordinal) || args[1].Length != 51 ||
                !int.TryParse(args[3], out var servicePid) || servicePid <= 0) return 2;
            var engine = args[5] == "engine";
            using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous);
            using var bootstrapTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            pipe.ConnectAsync(bootstrapTimeout.Token).GetAwaiter().GetResult();
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != servicePid) return 3;
            using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
            writer.WriteLine("LIBRARY-RMM-SUPPORT/1");
            var line = SupportPipeFraming.ReadLineAsync(reader, 8192, bootstrapTimeout.Token).GetAwaiter().GetResult();
            if (line is null || line.Length > 8192) return 4;
            bool isSystem;
            using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) isSystem = identity.IsSystem;
            if (engine)
            {
                // The screen helper exists only as SYSTEM, started by the service.
                var bootstrap = JsonSerializer.Deserialize<SupportBootstrap>(line, SupportBootstrap.Json) ?? throw new InvalidDataException("Missing support bootstrap.");
                bootstrap.Validate(DateTimeOffset.UtcNow);
                if (bootstrap.ServiceProcessId != servicePid || bootstrap.UserSessionId != Process.GetCurrentProcess().SessionId) return 5;
                if (!isSystem || !bootstrap.SystemHelper) return 6;
                writer.WriteLine("BOOTSTRAP-RECEIVED");
                using var session = new SupportEngine(bootstrap, reader, writer);
                session.RunAsync().GetAwaiter().GetResult();
                return 0;
            }
            // The notice exists only as the signed-in (non-SYSTEM) user, and holds no relay credential.
            var notice = JsonSerializer.Deserialize<SupportNoticeBootstrap>(line, SupportBootstrap.Json) ?? throw new InvalidDataException("Missing support notice.");
            notice.Validate(DateTimeOffset.UtcNow);
            if (notice.ServiceProcessId != servicePid || notice.UserSessionId != Process.GetCurrentProcess().SessionId) return 5;
            if (isSystem) return 6;
            writer.WriteLine("BOOTSTRAP-RECEIVED");
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using var window = new SupportWindow(notice, reader, writer);
            Application.Run(window);
            return 0;
        }
        catch
        {
            // Do not log bootstrap contents or scoped credentials. Failure cannot approve capture.
            return 10;
        }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out int processId);
}
