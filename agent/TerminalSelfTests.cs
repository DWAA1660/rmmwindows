using System.Text;

namespace LibraryRmm.Agent;

public static class TerminalSelfTests
{
    public static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "rmm-terminal-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var shell = await TerminalShell.StartAsync(root, CancellationToken.None);
            var output = new StringBuilder(); var errors = new StringBuilder();
            Task Emit(string name, string text) { lock (output) { (name == "stderr" ? errors : output).Append(text); } return Task.CompletedTask; }
            var path = root.Replace("'", "''", StringComparison.Ordinal);
            var one = await shell.ExecuteAsync($"$savedNumber=42; function Get-Saved {{ 'hello' }}; Set-Location '{path}'; 'first'", Emit, 20, CancellationToken.None);
            Assert(!one.Result.Interrupted && one.Result.ExitCode == 0 && SamePath(one.WorkingDirectory, root),
                $"Initial terminal command failed: interrupted={one.Result.Interrupted}; exit={one.Result.ExitCode}; reason={one.Result.InterruptionReason ?? "none"}; cwd={one.WorkingDirectory ?? "null"}; expected={root}; stdout={output}; stderr={errors}");
            output.Clear(); errors.Clear();
            var two = await shell.ExecuteAsync("\"$savedNumber $(Get-Saved)\"; [Console]::Write('α中文🙂' + ('x' * 300000)); [Console]::Error.Write('terminal-stderr')", Emit, 20, CancellationToken.None);
            Assert(!two.Result.Interrupted && SamePath(two.WorkingDirectory, root) && output.ToString().StartsWith("42 hello"), "Terminal variables/functions/cwd did not survive: " + output.ToString()[..Math.Min(100, output.Length)] + errors);
            Assert(output.ToString().EndsWith("α中文🙂" + new string('x', 300000)) && errors.ToString() == "terminal-stderr", "Terminal lost long output or stderr.");
            output.Clear(); errors.Clear();
            var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var live = shell.ExecuteAsync("[Console]::Write('live-5%'); Start-Sleep -Seconds 2; [Console]::Write('live-100%')", (name, text) => { if (text.Contains("live-5%")) first.TrySetResult(); return Emit(name, text); }, 20, CancellationToken.None);
            await first.Task.WaitAsync(TimeSpan.FromSeconds(10)); Assert(!live.IsCompleted, "Partial progress was buffered to completion.");
            Assert(!(await live).Result.Interrupted, "Live command was interrupted.");
            var failure = await shell.ExecuteAsync("throw 'intentional terminal test error'", Emit, 20, CancellationToken.None);
            Assert(!failure.Result.Interrupted && failure.Result.ExitCode == 1, "Script failure should leave the terminal alive.");
            var recovery = await shell.ExecuteAsync("$savedNumber", Emit, 20, CancellationToken.None);
            Assert(!recovery.Result.Interrupted, "Script failure destroyed persistent state.");
            var timeout = await shell.ExecuteAsync("Start-Sleep -Seconds 10", Emit, 1, CancellationToken.None);
            Assert(timeout.Result.Interrupted && shell.Ended, "Timeout did not end the terminal process.");
            var rejected = false;
            try { await shell.ExecuteAsync("'must never run'", Emit, 10, CancellationToken.None); } catch (IOException) { rejected = true; }
            Assert(rejected, "An ended terminal was recreated or reused.");
            Console.WriteLine("PASS stateful terminal variables/functions/cwd,300KBUnicode/stdout/stderr,liveprogress,errorrecovery,timeout/noresume (isolated local process)");

            // Regression: the console host joins the job object only sometimes (startup race), which
            // used to end a perfectly normal first command. Start ten fresh shells in a row.
            for (var round = 1; round <= 10; round++)
            {
                using var fresh = await TerminalShell.StartAsync(Path.Combine(root, "round-" + round), CancellationToken.None);
                var buffer = new StringBuilder();
                var result = await fresh.ExecuteAsync("'round-ok'", (_, text) => { lock (buffer) buffer.Append(text); return Task.CompletedTask; }, 20, CancellationToken.None);
                Assert(!result.Result.Interrupted && result.Result.ExitCode == 0 && buffer.ToString().Contains("round-ok"),
                    $"Fresh terminal round {round} failed its first command: {result.Result.InterruptionReason ?? "no reason"}; output={buffer}");
                var again = await fresh.ExecuteAsync("'second-ok'", (_, _) => Task.CompletedTask, 20, CancellationToken.None);
                Assert(!again.Result.Interrupted, $"Fresh terminal round {round} failed its second command: {again.Result.InterruptionReason}");
            }
            Console.WriteLine("PASS ten fresh terminals: first and second commands never misreported as background processes");

            // A real detached background process must end the terminal and be killed with it.
            using (var background = await TerminalShell.StartAsync(Path.Combine(root, "background"), CancellationToken.None))
            {
                var text = new StringBuilder();
                var spawned = await background.ExecuteAsync("$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; \"child=$($p.Id)\"",
                    (_, value) => { lock (text) text.Append(value); return Task.CompletedTask; }, 20, CancellationToken.None);
                Assert(spawned.Result.Interrupted && background.Ended && (spawned.Result.InterruptionReason ?? "").Contains("background", StringComparison.OrdinalIgnoreCase),
                    "A detached background process did not end the terminal: " + spawned.Result.InterruptionReason);
                var match = System.Text.RegularExpressions.Regex.Match(text.ToString(), @"child=(\d+)");
                Assert(match.Success, "Background test child PID was not reported: " + text);
                var childId = int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                var gone = false;
                for (var wait = 0; wait < 50 && !gone; wait++) { gone = !TerminalProcessJob.IsAlive(childId); if (!gone) await Task.Delay(100); }
                Assert(gone, $"Background child {childId} survived the terminal it escaped from.");
            }
            Console.WriteLine("PASS detached background process ends the terminal and is killed with it");

            // If output cannot be retained, the command must stop promptly, not at its (long) timeout.
            using (var failing = await TerminalShell.StartAsync(Path.Combine(root, "output-failure"), CancellationToken.None))
            {
                var clock = System.Diagnostics.Stopwatch.StartNew();
                var failed = await failing.ExecuteAsync("while ($true) { [Console]::Out.Write('x' * 65536) }",
                    (_, _) => throw new IOException("simulated durable spool failure"), 120, CancellationToken.None);
                clock.Stop();
                Assert(failed.Result.Interrupted && failing.Ended && clock.Elapsed < TimeSpan.FromSeconds(15),
                    $"Output failure did not stop the command promptly ({clock.Elapsed.TotalSeconds:F1}s): {failed.Result.InterruptionReason}");
            }
            Console.WriteLine("PASS output retention failure stops the command within seconds, not at its timeout");
        }
        finally
        {
            var target = Path.GetFullPath(root); var parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!target.StartsWith(parent, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(target).StartsWith("rmm-terminal-test-", StringComparison.Ordinal)) throw new IOException("Refusing test cleanup outside its owned temporary folder.");
            Directory.Delete(target, true);
        }
    }
    private static void Assert(bool yes, string message) { if (!yes) throw new InvalidOperationException(message); }
    private static bool SamePath(string? actual, string expected) => actual is not null && Path.GetFullPath(actual).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(expected).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
}
