using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace LibraryRmm.Agent;

/// <summary>One hidden, stateful PowerShell process. Commands are supplied only AFTER durable
/// server start authorization. Never recreate this object for the same terminal after failure.</summary>
internal sealed class TerminalShell : IDisposable
{
    private readonly Process process;
    private readonly NamedPipeServerStream pipe;
    private readonly StreamReader reader;
    private readonly StreamWriter writer;
    private readonly TerminalProcessJob processJob;
    // Processes legitimately in the job once PowerShell is running: the shell itself and, depending
    // on a startup race (the job is assigned just after Process.Start), Windows' console host.
    private HashSet<int> baseline = [];
    private bool ended;
    public bool Ended => ended || process.HasExited;
    private TerminalShell(Process process, NamedPipeServerStream pipe, TerminalProcessJob processJob)
    {
        this.process = process; this.pipe = pipe; this.processJob = processJob;
        reader = new StreamReader(pipe, new UTF8Encoding(false), false, 8192, true);
        writer = new StreamWriter(pipe, new UTF8Encoding(false), 8192, true) { AutoFlush = true };
    }
    public static async Task<TerminalShell> StartAsync(string directory, CancellationToken ct)
    {
        Directory.CreateDirectory(directory);
        var name = "LibraryRmm.Terminal." + Guid.NewGuid().ToString("N");
        var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var wrapper = Path.Combine(directory, "terminal-host.ps1");
        await File.WriteAllTextAsync(wrapper, Wrapper(name), new UTF8Encoding(true), ct);
        var start = new ProcessStartInfo(PowerShellRunner.PowerShellPath)
        {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System)
        };
        foreach (var arg in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", wrapper }) start.ArgumentList.Add(arg);
        var process = new Process { StartInfo = start };
        TerminalProcessJob? job = null;
        try
        {
            if (!process.Start()) throw new IOException("PowerShell did not start.");
            process.StandardInput.Close(); // Native stdin prompts receive EOF; Read-Host fails explicitly.
            job = new TerminalProcessJob(process);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct);
            startup.CancelAfter(TimeSpan.FromSeconds(20));
            await pipe.WaitForConnectionAsync(startup.Token);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) || pid != process.Id)
                throw new IOException("Unexpected terminal pipe client.");
            // By now PowerShell is running its script, so its console host already exists and job
            // membership is settled. Accept only the shell and the real system conhost.exe.
            var baseline = new HashSet<int> { process.Id };
            foreach (var member in job.ActiveProcessIds)
            {
                if (member == process.Id) continue;
                if (!TerminalProcessJob.IsSystemConsoleHost(member))
                    throw new IOException("Unexpected process in a new terminal before any command ran: " + DescribeProcess(member));
                baseline.Add(member);
            }
            return new TerminalShell(process, pipe, job) { baseline = baseline };
        }
        catch
        {
            job?.Dispose(); pipe.Dispose();
            try { if (!process.HasExited) process.Kill(true); } catch (InvalidOperationException) { }
            process.Dispose(); throw;
        }
    }
    public async Task<(ProcessResult Result, string? WorkingDirectory)> ExecuteAsync(string script, Func<string, string, Task> output, int seconds, CancellationToken ct)
    {
        if (Ended) throw new IOException("This terminal process ended. Open a new terminal; state is never recreated automatically.");
        var fence = "__LIBRARY_RMM_" + Guid.NewGuid().ToString("N") + "__";
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(seconds, 1, 3600)));
        var stdout = ReadUntilFenceAsync(process.StandardOutput.BaseStream, fence, "stdout", output, deadline.Token);
        var stderr = ReadUntilFenceAsync(process.StandardError.BaseStream, fence, "stderr", output, deadline.Token);
        try
        {
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { source = Convert.ToBase64String(Encoding.UTF8.GetBytes(script)), fence }).AsMemory(), deadline.Token);
            // If output cannot be durably retained (a pump faulted), stop now instead of waiting for
            // the command to finish or time out while its blocked pipe stalls the process.
            var resultTask = LibraryRmm.Support.SupportPipeFraming.ReadLineAsync(reader, 16384, deadline.Token);
            var pumpFault = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            foreach (var pump in new[] { stdout, stderr })
                _ = pump.ContinueWith(t => pumpFault.TrySetException(t.Exception!.InnerExceptions), CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            if (await Task.WhenAny(resultTask, pumpFault.Task) == pumpFault.Task && !resultTask.IsCompleted)
            {
                _ = resultTask.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
                await pumpFault.Task; // Rethrows the output failure (IOException or the callback's exception).
            }
            var resultLine = await resultTask;
            if (resultLine is null) throw new IOException("PowerShell exited before confirming the command boundary.");
            using var document = JsonDocument.Parse(resultLine);
            var result = document.RootElement;
            if (result.GetProperty("fence").GetString() != fence) throw new IOException("Terminal command boundary mismatch.");
            var exitCode = result.GetProperty("exitCode").GetInt32();
            var cwd = result.GetProperty("workingDirectory").GetString();
            await Task.WhenAll(stdout, stderr);
            // A detached child retaining console handles cannot be attributed to the next command.
            // End the session, kill its owned descendants and drain their remaining bytes explicitly.
            await EnsureNoBackgroundProcessesAsync();
            return (new ProcessResult(exitCode, false, null), cwd);
        }
        catch (Exception exception)
        {
            End();
            try { await Task.WhenAll(stdout, stderr).WaitAsync(TimeSpan.FromSeconds(3)); } catch { /* Error reported explicitly below; accepted chunks remain durable. */ }
            using var drain = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            // Preserve residual bytes if a fence was reached before a descendant was terminated.
            if (stdout.IsCompletedSuccessfully) try { await DrainAsync(process.StandardOutput.BaseStream, "stdout", output, drain.Token); } catch (OperationCanceledException) { }
            if (stderr.IsCompletedSuccessfully) try { await DrainAsync(process.StandardError.BaseStream, "stderr", output, drain.Token); } catch (OperationCanceledException) { }
            return (new ProcessResult(-1, true, "Terminal ended or timed out; its state will not be recreated and this command will not be retried. " + exception.GetType().Name + ": " + exception.Message), null);
        }
    }
    /// <summary>Anything still alive in the job besides the baseline after a command is a detached
    /// background process: it could write into the next command's output, so the terminal ends (the
    /// job object kills it). Processes already on their way out get a short grace period.</summary>
    private async Task EnsureNoBackgroundProcessesAsync()
    {
        int[] extra = [];
        for (var attempt = 0; attempt < 20; attempt++)
        {
            if (ended) throw new IOException("Terminal ended while checking for background processes.");
            extra = processJob.ActiveProcessIds.Where(pid => !baseline.Contains(pid) && TerminalProcessJob.IsAlive(pid)).ToArray();
            if (extra.Length == 0) return;
            await Task.Delay(50);
        }
        throw new IOException("A command left background processes running; terminal ended to keep output boundaries reliable: " + string.Join(", ", extra.Select(DescribeProcess)));
    }
    private static async Task DrainAsync(Stream stream, string name, Func<string, string, Task> output, CancellationToken ct)
    {
        var buffer = new byte[8192]; var decoder = new AdaptiveOutputDecoder(); int count;
        while ((count = await stream.ReadAsync(buffer.AsMemory(), ct)) > 0)
        { var text = decoder.Decode(buffer.AsSpan(0, count)); if (text.Length > 0) await output(name, text); }
        var tail = decoder.Flush(); if (tail.Length > 0) await output(name, tail);
    }
    // Fence is removed before decoding, so native UTF-16 and UTF-8 progress can coexist.
    // It is random per command, never taken from endpoint output or supplied by the operator.
    internal static async Task ReadUntilFenceAsync(Stream stream, string marker, string name, Func<string, string, Task> output, CancellationToken ct)
    {
        var fence = Encoding.ASCII.GetBytes(marker); var pending = Array.Empty<byte>();
        var buffer = new byte[8192]; var decoder = new AdaptiveOutputDecoder();
        async Task Emit(byte[] bytes, int count, bool final)
        {
            var text = decoder.Decode(bytes.AsSpan(0, count)) + (final ? decoder.Flush() : "");
            if (text.Length > 0) await output(name, text);
        }
        while (true)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(), ct);
            if (count == 0) { await Emit(pending, pending.Length, true); throw new IOException("Terminal output ended before its command boundary."); }
            var bytes = new byte[pending.Length + count]; pending.CopyTo(bytes, 0); buffer.AsSpan(0, count).CopyTo(bytes.AsSpan(pending.Length));
            var at = bytes.AsSpan().IndexOf(fence);
            if (at >= 0)
            {
                await Emit(bytes, at, true);
                if (at + fence.Length != bytes.Length)
                {
                    var extra = bytes[(at + fence.Length)..]; await output(name, Encoding.UTF8.GetString(extra));
                    throw new IOException("Unexpected background output followed a command boundary; session ended.");
                }
                return;
            }
            var keep = Math.Min(bytes.Length, fence.Length - 1);
            while (keep > 0 && !bytes.AsSpan(bytes.Length - keep).SequenceEqual(fence.AsSpan(0, keep))) keep--;
            await Emit(bytes, bytes.Length - keep, false); pending = bytes[(bytes.Length - keep)..];
        }
    }
    public void End() { ended = true; processJob.Dispose(); try { if (!process.HasExited) process.Kill(true); } catch (InvalidOperationException) { } }
    private static string DescribeProcess(int pid)
    {
        try { using var value = Process.GetProcessById(pid); return pid + ":" + value.ProcessName + ":" + value.MainModule?.FileName; }
        catch (Exception exception) when (exception is InvalidOperationException or ArgumentException or Win32Exception) { return pid + ":exited_or_unavailable"; }
    }
    public void Dispose() { End(); reader.Dispose(); writer.Dispose(); pipe.Dispose(); process.Dispose(); }
    private static string Wrapper(string pipeName) => $$$"""
        $ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'
        [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
        [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
        $OutputEncoding=[Console]::OutputEncoding; $FormatEnumerationLimit=-1
        foreach($width in 32766,16384,8192,4096){try{$Host.UI.RawUI.BufferSize=New-Object Management.Automation.Host.Size($width,[Math]::Max($Host.UI.RawUI.WindowSize.Height,1));break}catch{}}
        {{{PowerShellRunner.LiveConsoleFunctions()}}}
        $__rmmPipe=New-Object IO.Pipes.NamedPipeClientStream('.', '{{{pipeName}}}', [IO.Pipes.PipeDirection]::InOut)
        $__rmmPipe.Connect(15000)
        $__rmmReader=New-Object IO.StreamReader($__rmmPipe, (New-Object Text.UTF8Encoding($false)))
        $__rmmWriter=New-Object IO.StreamWriter($__rmmPipe, (New-Object Text.UTF8Encoding($false)))
        $__rmmWriter.AutoFlush=$true
        while($null -ne ($__rmmLine=$__rmmReader.ReadLine())) {
            $__rmmRequest=$__rmmLine|ConvertFrom-Json
            $__rmmSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__rmmRequest.source))
            $__rmmCode=0; $global:LASTEXITCODE=0
            try {
                . ([ScriptBlock]::Create($__rmmSource)) | Out-Default
                $__rmmOk=$?
                if($global:LASTEXITCODE -ne 0){$__rmmCode=$global:LASTEXITCODE}elseif(-not $__rmmOk){$__rmmCode=1}
            } catch { Write-Error $_; $__rmmCode=1 }
            [Console]::Out.Write($__rmmRequest.fence); [Console]::Out.Flush()
            [Console]::Error.Write($__rmmRequest.fence); [Console]::Error.Flush()
            $__rmmWriter.WriteLine((@{fence=$__rmmRequest.fence;exitCode=$__rmmCode;workingDirectory=$PWD.Path}|ConvertTo-Json -Compress))
        }
        """;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out int processId);
}

internal sealed class TerminalProcessJob : IDisposable
{
    private readonly SafeFileHandle handle;
    public TerminalProcessJob(Process process)
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        var limits = new Limits(); limits.Basic.Flags = 0x2000;
        if (handle.IsInvalid || !SetInformationJobObject(handle, 9, ref limits, Marshal.SizeOf<Limits>()) || !AssignProcessToJobObject(handle, process.Handle))
        { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not contain terminal process lifetime."); }
    }
    public int ActiveProcesses
    {
        get
        {
            var value = Marshal.AllocHGlobal(48);
            try { if (!QueryInformationJobObject(handle, 1, value, 48, IntPtr.Zero)) throw new IOException("Could not inspect terminal descendants."); return Marshal.ReadInt32(value, 40); }
            finally { Marshal.FreeHGlobal(value); }
        }
    }
    public int[] ActiveProcessIds
    {
        get
        {
            for (var capacity = 32; capacity <= 4096; capacity *= 2)
            {
                var size = 8 + capacity * IntPtr.Size;
                var memory = Marshal.AllocHGlobal(size);
                try
                {
                    if (!QueryInformationJobObject(handle, 3, memory, size, IntPtr.Zero))
                    {
                        if (Marshal.GetLastWin32Error() == 234) continue;
                        throw new IOException("Could not inspect terminal descendant identities.");
                    }
                    var count = Marshal.ReadInt32(memory, 4);
                    if (count < 0 || count > capacity) throw new IOException("Invalid terminal descendant list.");
                    var ids = new int[count];
                    for (var index = 0; index < count; index++) ids[index] = checked((int)Marshal.ReadIntPtr(memory, 8 + index * IntPtr.Size).ToInt64());
                    return ids;
                }
                finally { Marshal.FreeHGlobal(memory); }
            }
            throw new IOException("Too many terminal descendants to establish a reliable boundary.");
        }
    }
    public void Dispose() => handle.Dispose();
    public static bool IsAlive(int pid)
    {
        var process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return false;
        try { return GetExitCodeProcess(process, out var code) && code == 259; } // STILL_ACTIVE
        finally { CloseHandle(process); }
    }
    /// <summary>True only for the genuine Windows console host image, checked by full path.</summary>
    public static bool IsSystemConsoleHost(int pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return false;
        try
        {
            var buffer = new StringBuilder(1024); var size = buffer.Capacity;
            if (!QueryFullProcessImageName(process, 0, buffer, ref size)) return false;
            return string.Equals(Path.GetFullPath(buffer.ToString()), Path.Combine(Environment.SystemDirectory, "conhost.exe"), StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseHandle(process); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [StructLayout(LayoutKind.Sequential)] private struct Basic { public long Time1, Time2; public uint Flags; public UIntPtr Min, Max; public uint Count; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct Io { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] private struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref Limits limits, int bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, IntPtr info, int bytes, IntPtr required);
}
