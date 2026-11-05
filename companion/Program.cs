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
            // Manual developer check of the sign-in-screen helper's desktop thread on the current desktop:
            // attach, enumerate monitors and capture one frame in memory (discarded, never sent or saved).
            using var thread = new InputDesktopThread();
            var result = thread.RunAsync(() =>
            {
                var desktop = thread.Attach();
                var monitors = InputDesktopThread.Monitors();
                var frame = monitors.Count > 0 ? DesktopCapture.Capture(monitors[0].Bounds) : [];
                return (desktop, monitors.Count, frame.Length, InputDesktopThread.EmergencyKeysDown());
            }).GetAwaiter().GetResult();
            Console.WriteLine($"desktop={result.desktop} monitors={result.Item2} jpegBytes={result.Item3} emergencyKeysDown={result.Item4}");
            return result.desktop is not null && result.Item2 > 0 && result.Item3 > 0 && !result.Item4 ? 0 : 1;
        }
        try
        {
            if (args.Length != 4|| args[0] != "--pipe" || args[2] != "--service-pid" ||
                !args[1].StartsWith("LibraryRmm.Support.", StringComparison.Ordinal) || args[1].Length != 51 ||
                !int.TryParse(args[3], out var servicePid) || servicePid <= 0) return 2;
            using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous);
            using var bootstrapTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            pipe.ConnectAsync(bootstrapTimeout.Token).GetAwaiter().GetResult();
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != servicePid) return 3;
            using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
            writer.WriteLine("LIBRARY-RMM-SUPPORT/1");
            var line = SupportPipeFraming.ReadLineAsync(reader, 8192, bootstrapTimeout.Token).GetAwaiter().GetResult();
            if (line is null || line.Length > 8192) return 4;
            var bootstrap = JsonSerializer.Deserialize<SupportBootstrap>(line, SupportBootstrap.Json) ?? throw new InvalidDataException("Missing support bootstrap.");
            bootstrap.Validate(DateTimeOffset.UtcNow);
            if (bootstrap.ServiceProcessId != servicePid || bootstrap.UserSessionId != Process.GetCurrentProcess().SessionId) return 5;
            // The sign-in screen mode exists only as SYSTEM (started by the service); the normal mode never runs as SYSTEM.
            using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent())
                if (identity.IsSystem != bootstrap.SignInScreen) return 6;
            writer.WriteLine("BOOTSTRAP-RECEIVED");
            if (bootstrap.SignInScreen)
            {
                using var signIn = new SignInScreenSession(bootstrap, reader, writer);
                signIn.RunAsync().GetAwaiter().GetResult();
                return 0;
            }
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using var window = new SupportWindow(bootstrap, reader, writer);
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
