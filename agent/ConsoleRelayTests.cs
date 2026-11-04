using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LibraryRmm.Agent;

/// <summary>
/// Self-tests and safe synthetic child programs for <see cref="ConsoleRelay"/> and
/// <see cref="VtTextConverter"/>. Registered in <see cref="AgentSelfTests"/>. No real sfc/dism
/// repair is run; the buffered-progress child imitates sfc's pipe buffering.
/// </summary>
internal static class ConsoleRelayTests
{
    private const int ProgressSteps = 6;          // 0, 20, ... 100 %
    private static readonly TimeSpan StepDelay = TimeSpan.FromMilliseconds(600);

    // ----- Child programs (started through Program.cs) -----

    public static async Task<int> RunChildAsync(string[] args)
    {
        switch (args[0])
        {
            case "--self-test-buffered-progress": return await BufferedProgressChildAsync();
            case "--self-test-relay-unicode": return await UnicodeChildAsync();
            case "--self-test-relay-sleep":
                Console.Out.Write($"relay-child pid={Environment.ProcessId} parent={ConsoleRelay.ParentProcessIds().GetValueOrDefault(Environment.ProcessId)}\r\n");
                Console.Out.Flush();
                await Task.Delay(TimeSpan.FromSeconds(120));
                return 0;
            case "--self-test-relay-stdin":
            {
                // A prompting program must not hang: stdin reads end-of-file as in a normal job.
                var line = Console.In.ReadLine();
                Console.Out.Write($"stdout-console={!Console.IsOutputRedirected} stderr-console={!Console.IsErrorRedirected} stdin={(line is null ? "EOF" : "data")}\r\n");
                Console.Out.Flush();
                return 0;
            }
            case "--self-test-relay-args":
                Console.Out.Write("console=" + (!Console.IsOutputRedirected).ToString() + "\r\nargs=" + JsonSerializer.Serialize(args[1..]) + "\r\n");
                Console.Out.Flush();
                return 0;
            case "--self-test-relay-lines":
            {
                var builder = new StringBuilder();
                for (var line = 1; line <= LineCount; line++) builder.Append("line ").Append(line.ToString("D5", System.Globalization.CultureInfo.InvariantCulture)).Append(" of output\r\n");
                builder.Append(LongLine).Append("\r\n").Append("lines-done\r\n");
                Console.Out.Write(builder.ToString());
                Console.Out.Flush();
                return 0;
            }
            default: throw new ArgumentException("Unknown self-test child mode.");
        }
    }

    private const int LineCount = 2600; // More than the pseudo console's 2000 rows, so it scrolls.
    private static readonly string LongLine = "long:" + string.Concat(Enumerable.Range(0, 150).Select(i => $"[{i:D3}] word")) + ":end";

    /// <summary>Imitates sfc.exe: UTF-16 text, fully buffered (4096 bytes) when stdout is a pipe, immediate on a console.</summary>
    private static async Task<int> BufferedProgressChildAsync()
    {
        var updates = new List<string> { "\r\nBeginning verification phase of system scan.\r\n" };
        for (var step = 0; step < ProgressSteps; step++) updates.Add($"\rVerification {step * 100 / (ProgressSteps - 1)}% complete.");
        updates.Add("\r\nDone.\r\n");
        if (Console.IsOutputRedirected)
        {
            await using var stdout = Console.OpenStandardOutput();
            var pending = new List<byte>();
            foreach (var update in updates)
            {
                pending.AddRange(Encoding.Unicode.GetBytes(update));
                while (pending.Count >= 4096)
                {
                    await stdout.WriteAsync(pending.GetRange(0, 4096).ToArray());
                    pending.RemoveRange(0, 4096);
                }
                if (update.StartsWith("\rVerification", StringComparison.Ordinal)) await Task.Delay(StepDelay);
            }
            await stdout.WriteAsync(pending.ToArray()); // "at exit"
            await stdout.FlushAsync();
        }
        else
        {
            Console.OutputEncoding = Encoding.Unicode; // WriteConsoleW, like sfc on a console.
            foreach (var update in updates)
            {
                Console.Out.Write(update);
                Console.Out.Flush();
                if (update.StartsWith("\rVerification", StringComparison.Ordinal)) await Task.Delay(StepDelay);
            }
        }
        return 3;
    }

    private static async Task<int> UnicodeChildAsync()
    {
        if (!Console.IsOutputRedirected) Console.OutputEncoding = Encoding.Unicode;
        Console.Out.Write("Unicode α中文🙂 line\r\n");
        foreach (var percent in new[] { 10, 20, 30 })
        {
            Console.Out.Write($"\r中文🙂 progress {percent}%");
            Console.Out.Flush();
            await Task.Delay(300);
        }
        Console.Out.Write("\r\nunicode-done\r\n");
        Console.Out.Flush();
        return 0;
    }

    // ----- Tests -----

    public static Task ConverterAsync()
    {
        const string Esc = "\u001b";
        string Run(int width, int height, params string[] chunks)
        {
            var converter = new VtTextConverter(width, height);
            return string.Concat(chunks.Select(converter.Feed)) + converter.Flush();
        }
        void Expect(string actual, string expected, string label) =>
            Assert(actual == expected, $"{label}: expected {JsonSerializer.Serialize(expected)} got {JsonSerializer.Serialize(actual)}");

        Expect(Run(80, 25, "hello\r\nworld\r\n"), "hello\r\nworld\r\n", "plain lines");
        Expect(Run(80, 25, "a\r\n\r\nb"), "a\r\n\r\nb", "blank line kept");
        Expect(Run(80, 25, "one\ntwo\n"), "one\r\n   two\r\n", "bare LF keeps the column (VT semantics; ConPTY sends CRLF)");
        Expect(Run(80, 25, "Verification 5% complete.", "\rVerification 6% complete."), "Verification 5% complete.\rVerification 6% complete.", "CR progress");
        Expect(Run(80, 25, "Scan", "ning 1%"), "Scanning 1%", "appended text is emitted as a suffix");
        // ConPTY diff-only updates: only the changed cells, positioned with CUP.
        Expect(Run(80, 25, Esc + "[2J" + Esc + "[HBeginning verification phase of system scan.\r\n\r\nVerification 5% complete.", Esc + "[3;14H6", Esc + "[3;14H10% complete."),
            "Beginning verification phase of system scan.\r\n\r\nVerification 5% complete.\rVerification 6% complete.\rVerification 10% complete.", "diff-only CUP update");
        Expect(Run(80, 25, "a" + Esc + "[5Cb"), "a     b", "cursor forward over blanks");
        Expect(Run(80, 25, "abc def", Esc + "[5G" + Esc + "[K"), "abc def\rabc", "erase to end of line");
        Expect(Run(80, 25, "abc def", Esc + "[2K"), "abc def\r", "erase whole line");
        Expect(Run(80, 25, "abcdef", Esc + "[1;2H" + Esc + "[2P"), "abcdef\radef", "delete characters");
        Expect(Run(80, 25, "abcdef", Esc + "[1;2H" + Esc + "[2X"), "abcdef\ra  def", "erase characters");
        Expect(Run(80, 25, "first\r\nsecond\r\n", Esc + "[2J" + Esc + "[Hthird\r\n"), "first\r\nsecond\r\nthird\r\n", "clear screen keeps earlier text");
        Expect(Run(80, 25, Esc + "[?25l" + Esc + "[2J" + Esc + "[m" + Esc + "[H" + Esc + "]0;C:\\Windows\\system32\\sfc.exe\u0007" + Esc + "[?25hstart"), "start", "startup sequences before text");
        Expect(Run(80, 3, "1\r\n2\r\n3\r\n4\r\n5", Esc + "[3;1H6"), "1\r\n2\r\n3\r\n4\r\n5\r6", "scrolling at the bottom row");
        Expect(Run(80, 3, "a\r\nb\r\nc", Esc + "[H" + Esc + "[M" + Esc + "[3;1Hd"), "a\r\nb\r\nc\r\nd", "delete line at top scrolls");
        Expect(Run(80, 3, "a\r\nb\r\nc", Esc + "[S" + Esc + "[3;1Hd"), "a\r\nb\r\nc\r\nd", "scroll up");
        Expect(Run(80, 25, Esc + "]0;title\u0007hello " + Esc + "]2;other" + Esc + "\\world"), "hello world", "OSC title skipped (BEL and ST)");
        Expect(Run(80, 25, Esc + "[31mred" + Esc + "[0m " + Esc + "[1;38;2;1;2;3mrgb" + Esc + "[m" + Esc + "[?9001h" + Esc + "[?1004h" + Esc + "[2 q"), "red rgb", "SGR/private modes/cursor style dropped");
        Expect(Run(80, 25, "Verification 5%", Esc, "[", "1;1", "4H", "6", Esc + "]", "0;ti", "tle", Esc, "\\", Esc, "[16", "G!"), "Verification 5%\rVerification 6%!", "escape sequences split across Feed calls");
        Expect(Run(80, 25, "a\ud83d", "\ude42b"), "a🙂b", "surrogate pair split across Feed calls");
        Expect(Run(80, 25, "x🙂 10%", Esc + "[1;5H2"), "x🙂 10%\rx🙂 20%", "diff after a surrogate pair (two cells)");
        Expect(Run(80, 25, "中文 10%", Esc + "[1;6H2"), "中文 10%\r中文 20%", "diff after wide characters (two cells each)");
        Expect(Run(80, 25, "中文", Esc + "[1;2Hx"), "中文\r x文", "overwriting half of a wide character");
        Expect(Run(80, 25, "lone\ud83d!"), "lone\ufffd!", "unpaired surrogate replaced");
        Expect(Run(10, 5, "abcdefghijKLMNO\r\nnext"), "abcdefghijKLMNO\r\nnext", "long line wider than the screen is joined");
        Expect(Run(10, 5, "abcdefghi jkl\r\n"), "abcdefghi jkl\r\n", "wrapped line keeps the space at the edge");
        Expect(Run(10, 5, "abcdefghij\r\nx"), "abcdefghij\r\nx", "exact-width line then CRLF");
        Expect(Run(10, 2, string.Concat(Enumerable.Repeat("0123456789", 5)) + "\r\nz"), string.Concat(Enumerable.Repeat("0123456789", 5)) + "\r\nz", "long line across scrolling rows");
        Expect(Run(80, 25, "done\r\n"), "done\r\n", "final newline");
        Expect(Run(80, 25, "tab\tx"), "tab     x", "tab stop");
        Expect(Run(80, 25, "abc\bX"), "abX", "backspace overwrite");
        Expect(Run(80, 25, ""), "", "empty");

        // Every split point of a mixed stream renders the same text as feeding it whole.
        var sample = Esc + "[?25l" + Esc + "[2J" + Esc + "[HStart α中文🙂\r\n" + Esc + "]0;t\u0007Verification 5% complete." + Esc + "[2;14H6" + Esc + "[31m"
            + Esc + "[2;14H10% complete.\r\nDone." + Esc + "[m\r\n";
        var whole = Run(80, 25, sample);
        Expect(whole, "Start α中文🙂\r\nVerification 10% complete.\r\nDone.\r\n", "mixed sample (one read shows only the final screen)");
        for (var split = 0; split <= sample.Length; split++)
        {
            var parts = Run(80, 25, sample[..split], sample[split..]);
            Assert(Rendered(parts) == Rendered(whole) && !parts.Contains('\u001b'), $"Split at {split} changed the text: {JsonSerializer.Serialize(parts)}");
        }

        // Long runs stay fast and complete.
        var many = new VtTextConverter(512, 2000);
        var text = new StringBuilder();
        for (var line = 0; line < 20000; line++) text.Append(many.Feed($"row {line}\r\n"));
        text.Append(many.Flush());
        var lines = text.ToString().Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert(lines.Length == 20000 && lines[^1] == "row 19999", "Long run lost or reordered rows.");
        return Task.CompletedTask;
    }

    /// <summary>What a terminal shows: each line's text after its last carriage return.</summary>
    private static string Rendered(string text) =>
        string.Join("\n", text.Split("\r\n").Select(line => line[(line.LastIndexOf('\r') + 1)..]));

    public static Task CommandLineQuotingAsync()
    {
        string[] arguments = ["/scannow", "--x", "-n", "", "a b", "a\"b", "a\\\"b", "trailing\\", "trailing space\\", "\\\\server\\share\\", "tab\there", "two  spaces",
            "q\"\"", "\"", "\\", "αβ 中文 🙂", "C:\\Program Files\\x.exe", "/online", "/cleanup-image"];
        var commandLine = ConsoleRelay.BuildCommandLine(@"C:\Windows\System32\sfc.exe", arguments);
        var pointer = CommandLineToArgvW(commandLine, out var count);
        Assert(pointer != IntPtr.Zero, "CommandLineToArgvW failed.");
        try
        {
            var parsed = Enumerable.Range(0, count).Select(index => Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index * IntPtr.Size))!).ToArray();
            Assert(parsed[0] == @"C:\Windows\System32\sfc.exe" && parsed[1..].SequenceEqual(arguments),
                "Command line did not round-trip: " + commandLine + " -> " + JsonSerializer.Serialize(parsed));
        }
        finally { LocalFree(pointer); }
        Assert(ConsoleRelay.ResolveProgram("cmd") is { } cmd && cmd.EndsWith("cmd.exe", StringComparison.OrdinalIgnoreCase) && Path.IsPathFullyQualified(cmd), "PATH lookup failed.");
        Assert(ConsoleRelay.ResolveProgram("library-rmm-no-such-program") is null, "A missing program resolved.");
        return Task.CompletedTask;
    }

    /// <summary>(a) Documents the problem: a pipe-buffering program run directly shows progress only at exit.</summary>
    public static async Task DirectBufferedProgressAsync()
    {
        var run = await RunJobAsync("& " + AgentCommand() + " --self-test-buffered-progress", 60);
        Assert(run.Result.ExitCode == 3 && !run.Result.Interrupted, $"Direct buffered child exit {run.Result.ExitCode}.");
        Assert(run.Stdout.Contains("Verification 100% complete.", StringComparison.Ordinal) && run.Stdout.Contains("Done.", StringComparison.Ordinal), "Direct output incomplete: " + JsonSerializer.Serialize(run.Stdout));
        var minimum = StepDelay * ProgressSteps * 0.8;
        Assert(run.FirstProgress is { } first && first >= minimum, $"Expected the buffered child's first progress only at exit (>= {minimum.TotalSeconds:F1}s), got {run.FirstProgress?.TotalSeconds:F1}s.");
    }

    /// <summary>(b) Through Invoke-LiveConsole the same program streams each update, keeps its exit code, and sfc/dism are routed.</summary>
    public static async Task RelayLiveProgressAsync()
    {
        var script = "Invoke-LiveConsole " + AgentCommand() + " --self-test-buffered-progress\n"
            + "\"relay-exit=$LASTEXITCODE\"\n"
            + "\"routes=\" + (Get-Command sfc).CommandType + ',' + (Get-Command dism).CommandType + ',' + (Get-Command sfc.exe).CommandType + ',' + (Get-Command dism.exe).CommandType";
        var run = await RunJobAsync(script, 60);
        var text = run.Stdout;
        Assert(run.Result.ExitCode == 3 && !run.Result.Interrupted, $"Job exit code {run.Result.ExitCode}, expected the program's 3. Output: {JsonSerializer.Serialize(text)} {JsonSerializer.Serialize(run.Stderr)}");
        Assert(!run.Stderr.Contains("unavailable", StringComparison.Ordinal), "Pseudo console was not used: " + run.Stderr);
        Assert(text.Contains("Beginning verification phase of system scan.", StringComparison.Ordinal) && text.Contains("Verification 100% complete.", StringComparison.Ordinal)
            && text.Contains("Done.", StringComparison.Ordinal) && text.Contains("relay-exit=3", StringComparison.Ordinal), "Relay output incomplete: " + JsonSerializer.Serialize(text));
        Assert(text.Contains("routes=Function,Function,Application,Application", StringComparison.Ordinal), "sfc/dism are not routed through the relay (or sfc.exe is not an escape hatch): " + JsonSerializer.Serialize(text));
        Assert(run.FirstProgress is { } first && run.Elapsed - first >= StepDelay * (ProgressSteps - 2),
            $"Progress was not live: first update at {run.FirstProgress?.TotalSeconds:F1}s, job ended at {run.Elapsed.TotalSeconds:F1}s.");
        foreach (var percent in new[] { 0, 20, 40, 60, 80, 100 })
            Assert(text.Contains($"Verification {percent}% complete.", StringComparison.Ordinal), $"Progress {percent}% was not relayed: " + JsonSerializer.Serialize(text));
    }

    /// <summary>(c) A relayed program that outlives the job timeout is killed with the job: no orphaned child, relay or conhost.</summary>
    public static async Task RelayTimeoutKillsTreeAsync()
    {
        var held = new List<Process>();
        var names = new List<string>();
        var seen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var output = new StringBuilder();
        try
        {
            var directory = CreateTemp();
            try
            {
                var result = await new PowerShellRunner().RunScriptAsync("Invoke-LiveConsole " + AgentCommand() + " --self-test-relay-sleep", directory, (stream, text) =>
                {
                    lock (output)
                    {
                        output.Append(text);
                        var match = Regex.Match(output.ToString(), @"relay-child pid=(\d+) parent=(\d+)");
                        if (match.Success && held.Count == 0)
                        {
                            var child = int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                            var relay = int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
                            var parents = ConsoleRelay.ParentProcessIds();
                            foreach (var pid in new[] { relay }.Concat(parents.Where(entry => entry.Value == relay).Select(entry => entry.Key)).Append(child).Distinct())
                            {
                                try
                                {
                                    var process = Process.GetProcessById(pid);
                                    held.Add(process);
                                    names.Add(process.ProcessName + ":" + pid);
                                }
                                catch (ArgumentException) { }
                            }
                            seen.TrySetResult();
                        }
                    }
                    return Task.CompletedTask;
                }, 8, CancellationToken.None);
                Assert(result.Interrupted && result.InterruptionReason?.Contains("timed out", StringComparison.Ordinal) == true, "The job did not time out.");
            }
            finally { DeleteWithRetry(directory); }
            Assert(seen.Task.IsCompleted, "The relayed child never reported its PID (no live output): " + JsonSerializer.Serialize(output.ToString()));
            Assert(names.Any(name => name.StartsWith("conhost", StringComparison.OrdinalIgnoreCase) || name.StartsWith("OpenConsole", StringComparison.OrdinalIgnoreCase)),
                "The pseudo console host was not a child of the relay: " + string.Join(", ", names));
            Assert(held.Count >= 3, "Expected relay, child and conhost: " + string.Join(", ", names));
            var deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (var process in held)
                while (!process.HasExited && DateTime.UtcNow < deadline) await Task.Delay(100);
            var survivors = held.Where(process => !process.HasExited).Select(process => process.ProcessName + ":" + process.Id).ToArray();
            Assert(survivors.Length == 0, "Processes survived the job timeout: " + string.Join(", ", survivors) + " (tree: " + string.Join(", ", names) + ")");
        }
        finally
        {
            foreach (var process in held)
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                process.Dispose();
            }
        }
    }

    /// <summary>(d) Unicode, wide characters and progress after them survive the relay.</summary>
    public static async Task RelayUnicodeAsync()
    {
        var run = await RunJobAsync("Invoke-LiveConsole " + AgentCommand() + " --self-test-relay-unicode", 60);
        var text = run.Stdout;
        Assert(run.Result.ExitCode == 0 && text.Contains("Unicode α中文🙂 line", StringComparison.Ordinal) && text.Contains("unicode-done", StringComparison.Ordinal),
            "Unicode text changed in the relay: " + JsonSerializer.Serialize(text) + JsonSerializer.Serialize(run.Stderr));
        Assert(!text.Contains('\ufffd') && !text.Contains('\0'), "Replacement or NUL characters in relay output: " + JsonSerializer.Serialize(text));
        var progress = text.Split('\r', '\n').Where(segment => segment.Contains("progress", StringComparison.Ordinal)).ToArray();
        Assert(progress.Length > 0 && progress.All(segment => Regex.IsMatch(segment, "^中文🙂 progress (10|20|30)%$")) && progress[^1].EndsWith("30%", StringComparison.Ordinal),
            "Progress after wide characters was misplaced: " + JsonSerializer.Serialize(progress));
    }

    /// <summary>Arguments pass through PowerShell's $args and the relay's quoting untouched; the child has a console.</summary>
    public static async Task RelayArgumentsAsync()
    {
        string[] expected = ["/scannow", "--x", "-n", "a b", @"C:\Path With Space\x", "/Online", "αβ中文"];
        var run = await RunJobAsync("Invoke-LiveConsole " + AgentCommand() + " --self-test-relay-args /scannow --x -n 'a b' 'C:\\Path With Space\\x' /Online 'αβ中文'", 60);
        var match = Regex.Match(run.Stdout, "args=(\\[.*\\])");
        Assert(match.Success && JsonSerializer.Deserialize<string[]>(match.Groups[1].Value)!.SequenceEqual(expected), "Arguments changed: " + JsonSerializer.Serialize(run.Stdout));
        Assert(run.Stdout.Contains("console=True", StringComparison.Ordinal), "The relayed program did not get the pseudo console as stdout: " + JsonSerializer.Serialize(run.Stdout));
        var stdin = await RunJobAsync("Invoke-LiveConsole " + AgentCommand() + " --self-test-relay-stdin", 20);
        Assert(!stdin.Result.Interrupted && stdin.Stdout.Contains("stdout-console=True stderr-console=True stdin=EOF", StringComparison.Ordinal),
            "The relayed program's stdin did not read end-of-file (a prompt would hang until the timeout): " + JsonSerializer.Serialize(stdin.Stdout + stdin.Stderr));
        var missing = await RunJobAsync("Invoke-LiveConsole library-rmm-no-such-program; \"code=$LASTEXITCODE\"", 30);
        Assert(missing.Stdout.Contains("code=" + ConsoleRelay.ProgramNotFoundExitCode, StringComparison.Ordinal) && missing.Stderr.Contains("was not found", StringComparison.Ordinal),
            "A missing program was not reported: " + JsonSerializer.Serialize(missing.Stdout + missing.Stderr));
    }

    /// <summary>Output larger than the pseudo console (it scrolls) and a line wider than it arrive complete and in order.</summary>
    public static async Task RelayLongOutputAsync()
    {
        var run = await RunJobAsync("Invoke-LiveConsole " + AgentCommand() + " --self-test-relay-lines", 60);
        Assert(run.Result.ExitCode == 0, "Long output child failed.");
        var lines = run.Stdout.Split("\r\n");
        var numbered = lines.Where(line => line.StartsWith("line ", StringComparison.Ordinal)).ToArray();
        var expected = Enumerable.Range(1, LineCount).Select(line => $"line {line:D5} of output").ToArray();
        Assert(numbered.SequenceEqual(expected), $"Relayed lines were lost, duplicated or reordered ({numbered.Length} of {LineCount}). First difference: "
            + JsonSerializer.Serialize(numbered.Zip(expected).FirstOrDefault(pair => pair.First != pair.Second)));
        Assert(lines.Contains(LongLine), $"A {LongLine.Length}-character line was split or changed: " + JsonSerializer.Serialize(lines.Where(line => line.Contains("long:") || line.Contains(":end")).ToArray()));
        Assert(lines.Contains("lines-done"), "Final line missing.");
    }

    // ----- Helpers -----

    private sealed record JobRun(ProcessResult Result, string Stdout, string Stderr, TimeSpan? FirstProgress, TimeSpan Elapsed);

    private static async Task<JobRun> RunJobAsync(string script, int timeoutSeconds)
    {
        var directory = CreateTemp();
        try
        {
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            TimeSpan? first = null;
            var clock = Stopwatch.StartNew();
            var result = await new PowerShellRunner().RunScriptAsync(script, directory, (stream, text) =>
            {
                lock (stdout)
                {
                    (stream == "stderr" ? stderr : stdout).Append(text);
                    if (first is null && stdout.ToString().Contains("Verification", StringComparison.Ordinal)) first = clock.Elapsed;
                }
                return Task.CompletedTask;
            }, timeoutSeconds, CancellationToken.None);
            return new JobRun(result, stdout.ToString(), stderr.ToString(), first, clock.Elapsed);
        }
        finally { DeleteWithRetry(directory); }
    }

    /// <summary>The agent executable as PowerShell arguments ('exe', or 'dotnet.exe' 'LibraryRmm.Agent.dll' in development).</summary>
    private static string AgentCommand()
    {
        static string Literal(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing test process path.");
        var command = Literal(executable);
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            command += " " + Literal(Path.Combine(AppContext.BaseDirectory, "LibraryRmm.Agent.dll"));
        return command;
    }

    private static string CreateTemp()
    {
        var path = Path.Combine(Path.GetTempPath(), "library-rmm-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    // Killed processes can hold their working folder for a moment after exit (seen on CI runners).
    private static void DeleteWithRetry(string directory)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { if (Directory.Exists(directory)) Directory.Delete(directory, true); return; }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException && attempt < 40) { Thread.Sleep(250); }
        }
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
