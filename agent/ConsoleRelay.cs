using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LibraryRmm.Agent;

/// <summary>
/// <c>LibraryRmm.Agent.exe --console-relay &lt;program&gt; [args...]</c>: runs a console program
/// inside a pseudo console (ConPTY) and relays its screen as plain UTF-8 text to this process's
/// stdout, flushed after every read.
///
/// Why: sfc.exe (and other tools) fully buffer about 4 KB of output when stdout is a pipe, so
/// a job saw progress only in bursts minutes apart. Inside a pseudo console the program writes
/// to a console and updates its progress line immediately; <see cref="VtTextConverter"/> turns
/// the screen updates back into text with "\r" progress rewrites.
///
/// Process model: the child and the conhost.exe that serves the pseudo console are children of
/// this relay, so the job timeout's <c>Process.Kill(entireProcessTree: true)</c> on the
/// PowerShell process reaches them. The child is additionally placed in a kill-on-close job
/// object, so it never outlives the relay. Nothing is ever written to the child's input; a
/// program that prompts waits until the job timeout, exactly as before. The relay's exit code is
/// the child's exit code. Without ConPTY (before Windows 10 1809 / Server 2019) the program is
/// run directly with the relay's own standard handles.
/// </summary>
internal static class ConsoleRelay
{
    public const short Columns = 512;
    public const short Rows = 2000;
    public const int ProgramNotFoundExitCode = 9009;
    private static readonly TimeSpan QuietPeriod = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan MaxDrain = TimeSpan.FromSeconds(3);

    public static int Run(string[] arguments)
    {
        if (arguments.Length == 0 || string.IsNullOrWhiteSpace(arguments[0]))
        {
            Console.Error.WriteLine("Usage: Invoke-LiveConsole <program> [arguments...]");
            return 1;
        }
        var program = ResolveProgram(arguments[0]);
        if (program is null)
        {
            Console.Error.WriteLine($"Invoke-LiveConsole: '{arguments[0]}' was not found (searched PATH).");
            return ProgramNotFoundExitCode;
        }
        var commandLine = BuildCommandLine(program, arguments.AsSpan(1));
        try
        {
            return RunInPseudoConsole(commandLine);
        }
        catch (PseudoConsoleUnavailableException exception)
        {
            // Only thrown before the program was started, so it never runs twice.
            Console.Error.WriteLine($"Invoke-LiveConsole: pseudo console unavailable ({exception.Message}); running {Path.GetFileName(program)} directly, progress may be delayed.");
        }
        return RunDirect(program, arguments[1..]);
    }

    /// <summary>Finds an executable like PowerShell does: explicit paths as given, bare names on PATH only.</summary>
    internal static string? ResolveProgram(string name)
    {
        if (name.IndexOfAny(['\\', '/', ':']) >= 0)
        {
            var full = Path.GetFullPath(name);
            if (File.Exists(full)) return full;
            return Path.HasExtension(full) ? null : PathExtensions().Select(extension => full + extension).FirstOrDefault(File.Exists);
        }
        var candidates = Path.HasExtension(name) ? [name] : PathExtensions().Select(extension => name + extension).ToArray();
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string root;
            try
            {
                root = Environment.ExpandEnvironmentVariables(directory.Trim('"'));
                if (!Path.IsPathFullyQualified(root)) continue; // Never search the current directory.
            }
            catch (ArgumentException) { continue; }
            foreach (var candidate in candidates)
            {
                var path = Path.Combine(root, candidate);
                if (File.Exists(path)) return path;
            }
        }
        return null;
    }

    private static string[] PathExtensions() =>
        (Environment.GetEnvironmentVariable("PATHEXT") is { Length: > 0 } value ? value : ".COM;.EXE;.BAT;.CMD")
        .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>Builds a CreateProcess command line that CommandLineToArgvW/the C runtime split back into exactly these arguments.</summary>
    internal static string BuildCommandLine(string program, ReadOnlySpan<string> arguments)
    {
        if (program.Contains('"')) throw new ArgumentException("A program path cannot contain quotes.", nameof(program));
        var builder = new StringBuilder().Append('"').Append(program).Append('"');
        foreach (var argument in arguments)
        {
            builder.Append(' ');
            AppendQuoted(builder, argument);
        }
        return builder.ToString();
    }

    private static void AppendQuoted(StringBuilder builder, string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0)
        {
            builder.Append(argument);
            return;
        }
        builder.Append('"');
        for (var index = 0; ; index++)
        {
            var backslashes = 0;
            while (index < argument.Length && argument[index] == '\\') { backslashes++; index++; }
            if (index == argument.Length)
            {
                builder.Append('\\', backslashes * 2); // Before the closing quote.
                break;
            }
            if (argument[index] == '"') builder.Append('\\', backslashes * 2 + 1).Append('"');
            else builder.Append('\\', backslashes).Append(argument[index]);
        }
        builder.Append('"');
    }

    private static int RunDirect(string program, string[] arguments)
    {
        var start = new ProcessStartInfo(program) { UseShellExecute = false };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start " + program);
        process.WaitForExit();
        return process.ExitCode;
    }

    private sealed class PseudoConsoleUnavailableException(string message) : Exception(message);

    private static int RunInPseudoConsole(string commandLine)
    {
        if (!Native.CreatePipe(out var inputRead, out var inputWrite, IntPtr.Zero, 0)) throw new PseudoConsoleUnavailableException(new Win32Exception().Message);
        if (!Native.CreatePipe(out var outputRead, out var outputWrite, IntPtr.Zero, 0)) throw new PseudoConsoleUnavailableException(new Win32Exception().Message);
        using var job = CreateKillOnCloseJob();
        IntPtr pseudoConsole;
        using (inputRead)
        using (outputWrite)
        {
            int result;
            try { result = Native.CreatePseudoConsole(new Native.Coord(Columns, Rows), inputRead, outputWrite, 0, out pseudoConsole); }
            catch (EntryPointNotFoundException) { result = -1; pseudoConsole = IntPtr.Zero; }
            if (result != 0)
            {
                inputWrite.Dispose();
                outputRead.Dispose();
                throw new PseudoConsoleUnavailableException(result == -1 ? "this Windows version has no ConPTY" : new Win32Exception(result).Message);
            }
        } // The pseudo console holds its own copies; ours must close so the output pipe can end.

        Native.ProcessInformation process;
        int startError;
        try { process = StartSuspended(commandLine, pseudoConsole, out startError); }
        catch (PseudoConsoleUnavailableException)
        {
            Native.ClosePseudoConsole(pseudoConsole);
            inputWrite.Dispose();
            outputRead.Dispose();
            throw;
        }
        if (startError != 0)
        {
            Native.ClosePseudoConsole(pseudoConsole);
            inputWrite.Dispose();
            outputRead.Dispose();
            Console.Error.WriteLine($"Invoke-LiveConsole: could not start the program: {new Win32Exception(startError).Message}");
            return startError is 2 or 3 ? ProgramNotFoundExitCode : 1;
        }

        try
        {
            var stdout = new RelayOutput();
            var lastActivity = Stopwatch.GetTimestamp();
            var converter = new VtTextConverter(Columns, Rows);
            var decoder = new UTF8Encoding(false).GetDecoder();
            var gate = new object();
            var reader = new Thread(() =>
            {
                using var stream = new FileStream(outputRead, FileAccess.Read, 1, false);
                var buffer = new byte[16384];
                var chars = new char[buffer.Length + 4];
                try
                {
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        Volatile.Write(ref lastActivity, Stopwatch.GetTimestamp());
                        lock (gate)
                        {
                            var count = decoder.GetChars(buffer, 0, read, chars, 0, flush: false);
                            stdout.Write(converter.Feed(new string(chars, 0, count)));
                        }
                        // Nobody can receive output any more (the job ended or the agent stopped):
                        // exit, and the kill-on-close job ends the program with the relay.
                        if (stdout.Failed) Environment.Exit(1);
                    }
                }
                catch (IOException) { } // Pipe closed by the pseudo console.
            }) { IsBackground = true, Name = "console-relay-reader" };
            reader.Start();

            if (job is not null) Native.AssignProcessToJobObject(job, process.hProcess); // Best effort; the process tree kill still applies.
            Native.ResumeThread(process.hThread);
            Native.WaitForSingleObject(process.hProcess, Native.Infinite);
            if (!Native.GetExitCodeProcess(process.hProcess, out var code)) throw new Win32Exception();
            var exitCode = unchecked((int)code);

            // The final screen update can arrive after the child exits. Wait until the pseudo
            // console has been quiet for QuietPeriod since the exit (or its last output), then
            // close it, which ends the output pipe.
            var drainStarted = Stopwatch.GetTimestamp();
            while (Stopwatch.GetElapsedTime(Math.Max(Volatile.Read(ref lastActivity), drainStarted)) < QuietPeriod && Stopwatch.GetElapsedTime(drainStarted) < MaxDrain && reader.IsAlive)
                Thread.Sleep(50);
            var close = Task.Run(() => Native.ClosePseudoConsole(pseudoConsole));
            close.Wait(TimeSpan.FromSeconds(5)); // Older Windows waits for conhost here; the reader keeps draining meanwhile.
            reader.Join(MaxDrain);
            inputWrite.Dispose();
            lock (gate)
            {
                var tail = new char[8];
                var count = decoder.GetChars(Array.Empty<byte>(), 0, 0, tail, 0, flush: true);
                stdout.Write(converter.Feed(new string(tail, 0, count)) + converter.Flush());
            }
            return stdout.Failed ? 1 : exitCode;
        }
        finally
        {
            Native.CloseHandle(process.hThread);
            Native.CloseHandle(process.hProcess);
        }
    }

    /// <summary>Creates the child attached to the pseudo console, suspended. Returns a Win32 error (non-zero) if the program could not start.</summary>
    private static Native.ProcessInformation StartSuspended(string commandLine, IntPtr pseudoConsole, out int error)
    {
        error = 0;
        // Standard input is the NUL device, so a program reading stdin gets end-of-file at once,
        // exactly as in a normal job (the agent closes PowerShell's stdin). Only this handle is
        // inherited (handle list); the relay's own stdout/stderr pipes never reach the child.
        using var nul = File.OpenHandle(@"\\.\NUL", FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (!Native.SetHandleInformation(nul, Native.HandleFlagInherit, Native.HandleFlagInherit))
            throw new PseudoConsoleUnavailableException(new Win32Exception().Message);
        var size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        var attributeList = Marshal.AllocHGlobal(size);
        var handleList = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            if (!Native.InitializeProcThreadAttributeList(attributeList, 2, 0, ref size))
                throw new PseudoConsoleUnavailableException(new Win32Exception().Message);
            try
            {
                Marshal.WriteIntPtr(handleList, nul.DangerousGetHandle());
                if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.ProcThreadAttributePseudoConsole, pseudoConsole, IntPtr.Size, IntPtr.Zero, IntPtr.Zero)
                    || !Native.UpdateProcThreadAttribute(attributeList, 0, Native.ProcThreadAttributeHandleList, handleList, IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    throw new PseudoConsoleUnavailableException(new Win32Exception().Message);
                var startup = new Native.StartupInfoEx
                {
                    StartupInfo = new Native.StartupInfo
                    {
                        cb = Marshal.SizeOf<Native.StartupInfoEx>(),
                        // Null output handles make the child open the pseudo console. Without
                        // this flag a child inherits this relay's redirected stdout pipe and
                        // buffers exactly as before (verified by the self-tests).
                        dwFlags = Native.StartfUseStdHandles,
                        hStdInput = nul.DangerousGetHandle()
                    },
                    lpAttributeList = attributeList
                };
                var mutableCommandLine = new StringBuilder(commandLine, commandLine.Length + 1);
                if (!Native.CreateProcessW(null, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true,
                        Native.ExtendedStartupInfoPresent | Native.CreateSuspended, IntPtr.Zero, null, ref startup, out var process))
                    error = Marshal.GetLastWin32Error();
                return process;
            }
            finally { Native.DeleteProcThreadAttributeList(attributeList); }
        }
        finally
        {
            Marshal.FreeHGlobal(handleList);
            Marshal.FreeHGlobal(attributeList);
        }
    }

    private static SafeFileHandle? CreateKillOnCloseJob()
    {
        var job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) { job.Dispose(); return null; }
        var limits = new Native.JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = Native.JobObjectLimitKillOnJobClose;
        if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformationClass, ref limits, Marshal.SizeOf<Native.JobObjectExtendedLimitInformation>()))
        {
            job.Dispose();
            return null;
        }
        return job;
    }

    /// <summary>Writes relay text to stdout as UTF-8 and flushes immediately.</summary>
    private sealed class RelayOutput
    {
        private readonly Stream? stream = Console.IsOutputRedirected ? Console.OpenStandardOutput() : null;
        private readonly Encoder encoder = new UTF8Encoding(false).GetEncoder();
        public bool Failed { get; private set; }

        public void Write(string text)
        {
            if (text.Length == 0 || Failed) return;
            try
            {
                if (stream is null)
                {
                    Console.Out.Write(text); // Interactive use: let the console encode it.
                    Console.Out.Flush();
                    return;
                }
                var bytes = new byte[encoder.GetByteCount(text, flush: false)];
                encoder.GetBytes(text, bytes, flush: false);
                stream.Write(bytes);
                stream.Flush();
            }
            catch (IOException)
            {
                // The agent stopped reading (job ended). Mark it; the kill-on-close job ends the
                // child when the relay exits and the job tree kill ends the relay.
                Failed = true;
            }
        }
    }

    /// <summary>Parent process IDs of all running processes (used by self-tests to prove the tree is ended).</summary>
    internal static Dictionary<int, int> ParentProcessIds()
    {
        var map = new Dictionary<int, int>();
        using var snapshot = Native.CreateToolhelp32Snapshot(Native.Th32csSnapProcess, 0);
        if (snapshot.IsInvalid) throw new Win32Exception();
        var entry = new Native.ProcessEntry32 { dwSize = Marshal.SizeOf<Native.ProcessEntry32>() };
        for (var ok = Native.Process32FirstW(snapshot, ref entry); ok; ok = Native.Process32NextW(snapshot, ref entry))
            map[entry.th32ProcessID] = entry.th32ParentProcessID;
        return map;
    }

    private static class Native
    {
        public const uint Infinite = 0xFFFFFFFF;
        public const int StartfUseStdHandles = 0x00000100;
        public const uint ExtendedStartupInfoPresent = 0x00080000;
        public const uint CreateSuspended = 0x00000004;
        public static readonly IntPtr ProcThreadAttributePseudoConsole = 0x00020016;
        public static readonly IntPtr ProcThreadAttributeHandleList = 0x00020002;
        public const uint HandleFlagInherit = 0x00000001;
        public const uint JobObjectLimitKillOnJobClose = 0x00002000;
        public const int JobObjectExtendedLimitInformationClass = 9;
        public const uint Th32csSnapProcess = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        public readonly struct Coord(short x, short y) { public readonly short X = x; public readonly short Y = y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct StartupInfo
        {
            public int cb;
            public IntPtr lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ProcessInformation
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct ProcessEntry32
        {
            public int dwSize, cntUsage, th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public int th32ModuleID, cntThreads, th32ParentProcessID, pcPriClassBase, dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, IntPtr attributes, int size);

        [DllImport("kernel32.dll")]
        public static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pseudoConsole);

        [DllImport("kernel32.dll")]
        public static extern void ClosePseudoConsole(IntPtr pseudoConsole);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        public static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string? applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint creationFlags, IntPtr environment, string? currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref JobObjectExtendedLimitInformation information, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, int processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry32 entry);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry32 entry);
    }
}
