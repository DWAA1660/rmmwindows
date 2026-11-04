using System.Diagnostics;
using System.Text;

namespace LibraryRmm.Agent;

public sealed class PowerShellRunner
{
    public async Task<ProcessResult> RunScriptAsync(string script, string workingDirectory,
        Func<string, string, Task> onOutput, int timeoutSeconds, CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(workingDirectory);
        var scriptPath = Path.Combine(workingDirectory, "command.ps1");
        var wrapperPath = Path.Combine(workingDirectory, "invoke.ps1");
        await WritePowerShellAsync(scriptPath, script);
        // Explicit UTF-8 and wide formatting prevent the common 80-column host truncation.
        // Explicit Format-Table/custom formatting inside a script can still shorten objects;
        // the transport preserves every character the PowerShell process actually writes.
        var escapedPath = scriptPath.Replace("'", "''", StringComparison.Ordinal);
        await WritePowerShellAsync(wrapperPath, $$"""
            $ErrorActionPreference = 'Continue'
            $ProgressPreference = 'SilentlyContinue'
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
            $OutputEncoding = [Console]::OutputEncoding
            $FormatEnumerationLimit = -1
            $PSDefaultParameterValues['Out-File:Width'] = 32767
            try { $size = $Host.UI.RawUI.BufferSize; $size.Width = 32767; $Host.UI.RawUI.BufferSize = $size } catch { }
            $global:LASTEXITCODE = 0
            try {
                # Do not pipe the whole script through a formatting cmdlet: PowerShell then
                # captures native stdout as line objects and withholds CR/no-newline progress.
                # Standalone native programs must inherit the redirected output handles.
                & '{{escapedPath}}'
                $pipelineSucceeded = $?
                if ($global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }
                if (-not $pipelineSucceeded) { exit 1 }
                exit 0
            } catch {
                Write-Error $_
                exit 1
            }
            """);
        var start = new ProcessStartInfo(PowerShellPath)
        {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = workingDirectory
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", wrapperPath })
            start.ArgumentList.Add(argument);
        return await RunProcessAsync(start, onOutput, timeoutSeconds, stoppingToken);
    }

    public Task<ProcessResult> ScheduleRebootAsync(int delaySeconds, string reason, Func<string, string, Task> onOutput, CancellationToken ct)
    {
        if (delaySeconds is < 30 or > 86400) throw new ArgumentOutOfRangeException(nameof(delaySeconds));
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shutdown.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argument in new[] { "/r", "/t", delaySeconds.ToString(System.Globalization.CultureInfo.InvariantCulture), "/d", "p:0:0", "/c", reason })
            start.ArgumentList.Add(argument);
        return RunProcessAsync(start, onOutput, 15, ct);
    }

    public static string PowerShellPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");

    private static async Task WritePowerShellAsync(string path, string text)
    {
        // Windows PowerShell 5.1 needs the BOM to recognize non-ASCII script source as UTF-8.
        await File.WriteAllTextAsync(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
    }

    internal static async Task<ProcessResult> RunProcessAsync(ProcessStartInfo start,
        Func<string, string, Task> onOutput, int timeoutSeconds, CancellationToken stoppingToken)
    {
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new InvalidOperationException("Could not start the requested process.");
        process.StandardInput.Close(); // Scripts must never hang waiting for an interactive response.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 1, 86400)));
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, stoppingToken);
        using var drainCancellation = new CancellationTokenSource();
        var outputFailure = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task PumpGuardAsync(StreamReader reader, string stream)
        {
            try { await PumpAsync(reader.BaseStream, stream, onOutput, drainCancellation.Token); }
            catch (Exception exception) { outputFailure.TrySetResult(exception); throw; }
        }
        var stdout = PumpGuardAsync(process.StandardOutput, "stdout");
        var stderr = PumpGuardAsync(process.StandardError, "stderr");
        var pumps = Task.WhenAll(stdout, stderr);
        bool interrupted = false;
        string? reason = null;
        try
        {
            var exited = process.WaitForExitAsync(lifetime.Token);
            var winner = await Task.WhenAny(exited, outputFailure.Task);
            if (winner == outputFailure.Task)
            {
                TryKill(process);
                await process.WaitForExitAsync(CancellationToken.None);
                drainCancellation.Cancel();
                try { await pumps; } catch { /* Rethrow the original delivery failure below. */ }
                throw new IOException("Command output could not be durably retained; process tree terminated.", await outputFailure.Task);
            }
            await exited;
        }
        catch (OperationCanceledException)
        {
            interrupted = true;
            reason = stoppingToken.IsCancellationRequested ? "Agent service stopped; process tree terminated." : "Execution timed out; process tree terminated.";
            TryKill(process);
            await process.WaitForExitAsync(CancellationToken.None);
        }
        // Drain after exit/termination, including long lines without newline delimiters. A child
        // retaining inherited pipes must not hang the service forever; report incomplete output.
        try { await pumps.WaitAsync(TimeSpan.FromSeconds(15)); }
        catch (TimeoutException)
        {
            drainCancellation.Cancel();
            interrupted = true;
            reason = "A descendant retained an output pipe after the command ended. Output may be incomplete; command will not be rerun.";
            try { await pumps; } catch (OperationCanceledException) { }
        }
        return new ProcessResult(process.ExitCode, interrupted, reason);
    }

    private static void TryKill(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
    }

    private static async Task PumpAsync(Stream source, string stream, Func<string, string, Task> onOutput, CancellationToken ct)
    {
        // Read raw bytes so UTF-16LE writers (sfc.exe) and UTF-8 writers (PowerShell, DISM with
        // the UTF-8 console code page) both decode correctly, and partial progress without a
        // newline is delivered as soon as the pipe returns it.
        var decoder = new AdaptiveOutputDecoder();
        var buffer = new byte[8192];
        string? pendingSurrogate = null;
        async Task EmitAsync(string decoded, bool final)
        {
            var value = (pendingSurrogate ?? "") + decoded;
            pendingSurrogate = null;
            if (!final && value.Length != 0 && char.IsHighSurrogate(value[^1]))
            {
                pendingSurrogate = value[^1].ToString();
                value = value[..^1];
            }
            if (value.Length != 0) await onOutput(stream, value);
        }
        while (true)
        {
            var read = await source.ReadAsync(buffer.AsMemory(), ct);
            if (read == 0) break;
            await EmitAsync(decoder.Decode(buffer.AsSpan(0, read)), final: false);
        }
        await EmitAsync(decoder.Flush(), final: true);
    }
}
