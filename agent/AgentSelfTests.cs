using System.Net;
using System.Diagnostics;
using System.Text;
using System.Net.Http.Json;
using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Dependency-free checks; does not install a service, enroll, or invoke shutdown.</summary>
internal static class AgentSelfTests
{
    public static async Task<int> RunAsync()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("support cleanup survives disconnected pipes and repeated disposal (no desktop access)", SupportLifecycleSelfTests.RunAsync),
            ("agent update diagnostics preserve safe failure evidence", UpdateDiagnosticsTests.RunAsync),
            ("endpoint directory and diagnostics inventory parsing (no domain access)", InventorySelfTests.RunAsync),
            ("stateful remote terminal boundaries and lifecycle (isolated local PowerShell)", TerminalSelfTests.RunAsync),
            ("support permission, countdown, origin and input gates (no desktop access)", LibraryRmm.Support.SupportSelfTests.RunAsync),
            ("secure-attention broker scope, policy and replay gates (no Windows calls)", SupportBrokerSelfTests.RunAsync),
            ("support launch session choice and failure reasons (no WTS calls)", SupportLaunchSelfTests.RunAsync),
            ("UTF-8 chunks preserve long output and surrogate pairs", ChunkIntegrityAsync),
            ("execution gate requires a fresh true response and never retries", ExecutionGateAsync),
            ("recovery uploads interruption and existing output without replay", RecoveryAsync),
            ("failed output upload retries delivery without losing text", DeliveryRetryAsync),
            ("repeated job ID cannot replace an existing journal", DuplicateJournalAsync),
            ("mixed UTF-8/UTF-16LE output decodes identically at every read boundary", AdaptiveDecoderAsync),
            ("PowerShell keeps long lines, Unicode and stderr", PowerShellOutputAsync),
            ("PowerShell delivers partial progress before command completion", PowerShellLiveOutputAsync),
            ("native UTF-8 progress arrives live without a newline", () => NativeLiveOutputAsync("utf8")),
            ("native UTF-16LE progress arrives live without NUL corruption", () => NativeLiveOutputAsync("utf16le")),
            ("PowerShell timeout terminates command and reports interruption", PowerShellTimeoutAsync),
            ("unsafe storage paths are rejected", StoragePathAsync),
            ("updater accepts only newer safe manifests and backs off retries", UpdaterVersionRulesAsync),
            ("startup metadata retries transient boot failures with a strict bound", UpdaterManifestRetryAsync),
            ("updater stages only verified packages and never loops", UpdaterStagingAsync),
            ("updater honors the group's automatic-update setting from the authenticated manifest", UpdaterGroupPolicyAsync),
            ("tokenless join waits for approval, then persists the issued credential", JoinApprovalAsync),
            ("file explorer lists, copies, moves, renames and creates folders (temp only)", FileOperationsBasicAsync),
            ("file explorer recursive delete removes links without following them", FileOperationsLinkDeleteAsync),
            ("file explorer refuses protected, unsafe and secret paths", FileOperationsSafetyAsync),
            ("file explorer download sends exact bytes in chunks with SHA-256", FileOperationsDownloadAsync),
            ("file explorer folder download sends a complete zip and reports what was left out", FileOperationsFolderDownloadAsync),
            ("file explorer upload saves verified bytes only, never through links or into protected folders", FileOperationsUploadAsync),
            ("file explorer extract blocks zip slip, zip bombs and links, and keeps going per entry", FileOperationsExtractAsync),
            ("VT screen updates convert to plain text with CR progress", ConsoleRelayTests.ConverterAsync),
            ("relay command line round-trips arguments and searches PATH only", ConsoleRelayTests.CommandLineQuotingAsync),
            ("pipe-buffering child run directly shows progress only at exit", ConsoleRelayTests.DirectBufferedProgressAsync),
            ("Invoke-LiveConsole streams buffered progress live and keeps the exit code", ConsoleRelayTests.RelayLiveProgressAsync),
            ("relayed program is killed with the job on timeout (no orphans)", ConsoleRelayTests.RelayTimeoutKillsTreeAsync),
            ("Unicode and wide-character progress survive the relay", ConsoleRelayTests.RelayUnicodeAsync),
            ("relay passes arguments untouched and reports missing programs", ConsoleRelayTests.RelayArgumentsAsync),
            ("relay keeps long scrolling output and wide lines complete", ConsoleRelayTests.RelayLongOutputAsync)
        };
        var failed = 0;
        foreach (var test in tests)
        {
            try { await test.Run(); Console.WriteLine($"PASS {test.Name}"); }
            catch (Exception exception) { failed++; Console.Error.WriteLine($"FAIL {test.Name}: {exception.Message}"); }
        }
        Console.WriteLine($"{tests.Length - failed}/{tests.Length} agent checks passed. No service installation or reboot was performed.");
        return failed == 0 ? 0 : 1;
    }

    private static Task ChunkIntegrityAsync()
    {
        var source = string.Concat(Enumerable.Repeat("0123456789αβ中文🙂\r\n", 25000));
        var chunks = JobJournal.SplitUtf8(source, 16384).ToArray();
        Assert(chunks.Length > 10 && chunks.All(chunk => Encoding.UTF8.GetByteCount(chunk) <= 16384), "Chunk byte budget exceeded.");
        Assert(string.Concat(chunks) == source, "Output changed while chunking.");
        return Task.CompletedTask;
    }
    private static async Task ExecutionGateAsync()
    {
        var attempts = 0;
        var executions = 0;
        if (await ExecutionGate.StartOnceAsync(() => { attempts++; return Task.FromResult<StartResponse?>(new(false, "running")); })) executions++;
        if (await ExecutionGate.StartOnceAsync(() => { attempts++; return Task.FromResult<StartResponse?>(null); })) executions++;
        try { if (await ExecutionGate.StartOnceAsync(() => { attempts++; throw new HttpRequestException("Simulated lost authorization response"); })) executions++; }
        catch (HttpRequestException) { }
        Assert(attempts == 3 && executions == 0, "An uncertain/denied start executed or was retried.");
        if (await ExecutionGate.StartOnceAsync(() => { attempts++; return Task.FromResult<StartResponse?>(new(true, "running")); })) executions++;
        Assert(attempts == 4 && executions == 1, "Fresh start was not honored exactly once.");
    }
    private static async Task RecoveryAsync()
    {
        var directory = CreateTemp();
        try
        {
            var configuration = TestConfiguration(directory);
            var spool = new OutputSpool(configuration);
            var job = new AgentJob(Guid.NewGuid().ToString(), "powershell", JsonSerializer.SerializeToElement(new { script = "Write-Output test" }), "test-dispatch", 10);
            var journal = await spool.CreateAsync(job);
            var source = new string('x', 200_000) + "🙂\n";
            await journal.AppendAsync("stdout", source);
            await spool.RecoverInterruptedAsync();
            var handler = new RecordingHandler();
            using var api = new AgentApi(configuration, handler);
            await spool.FlushAsync(api, CancellationToken.None);
            Assert(handler.Paths.All(path => !path.EndsWith("/start", StringComparison.Ordinal) && !path.EndsWith("/claim", StringComparison.Ordinal)), "Recovery requested execution.");
            Assert(string.Concat(handler.Chunks.OrderBy(chunk => chunk.Sequence).Select(chunk => chunk.Text)) == source, "Recovery lost output.");
            Assert(handler.Completion?.Status == "interrupted", "Recovery did not mark ambiguous job interrupted.");
            Assert(!Directory.EnumerateDirectories(spool.Root).Any(), "Acknowledged spool was not cleaned up.");
        }
        finally { Directory.Delete(directory, true); }
    }
    private static async Task PowerShellOutputAsync()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = CreateTemp();
        try
        {
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            var result = await new PowerShellRunner().RunScriptAsync("[Console]::Out.Write(('Z' * 150000) + '🙂中文'); [Console]::Error.Write('stderr-test'); exit 0", directory,
                (stream, text) => { (stream == "stderr" ? stderr : stdout).Append(text); return Task.CompletedTask; }, 30, CancellationToken.None);
            Assert(result.ExitCode == 0 && !result.Interrupted, "PowerShell did not exit successfully.");
            Assert(stdout.ToString().Contains(new string('Z', 150000) + "🙂中文", StringComparison.Ordinal), "Long/Unicode output was shortened.");
            Assert(stderr.ToString().Contains("stderr-test", StringComparison.Ordinal), "stderr was not captured.");

            // Wide objects must not be cut to a console width, whether formatted implicitly
            // (default table view) or explicitly with Format-Table. The old wrapper guaranteed
            // this with Out-String -Width; the current one widens the hidden console buffer.
            foreach (var script in new[]
                     {
                         "[pscustomobject]@{ Name = ('w' * 400); Path = 'C:\\' + ('p' * 300); Marker = 'table-end' }",
                         "[pscustomobject]@{ Name = ('w' * 400); Path = 'C:\\' + ('p' * 300); Marker = 'table-end' }, [pscustomobject]@{ Name = 'b'; Path = 'c'; Marker = 'row2' } | Format-Table -AutoSize"
                     })
            {
                var formatted = new StringBuilder();
                var table = await new PowerShellRunner().RunScriptAsync(script, directory,
                    (_, text) => { formatted.Append(text); return Task.CompletedTask; }, 30, CancellationToken.None);
                var text = formatted.ToString();
                Assert(table.ExitCode == 0 && text.Contains(new string('w', 400), StringComparison.Ordinal) && text.Contains(new string('p', 300), StringComparison.Ordinal)
                    && text.Contains("table-end", StringComparison.Ordinal) && !text.Contains("...", StringComparison.Ordinal),
                    $"Formatted output was truncated ({text.Length} chars): " + JsonSerializer.Serialize(text.Replace("  ", "")));
            }
        }
        finally { Directory.Delete(directory, true); }
    }
    private static Task AdaptiveDecoderAsync()
    {
        var utf8 = new UTF8Encoding(false);
        var expected = "PS α start\r\n" + "\r\nVerification 10% α🙂\rVerification 100%\r\n" + "done ok\r\n" + "\rmore 50%" + "ok";
        var bytes = utf8.GetBytes("PS α start\r\n")
            .Concat(Encoding.Unicode.GetBytes("\r\nVerification 10% α🙂\rVerification 100%\r\n"))
            .Concat(utf8.GetBytes("done ok\r\n"))
            .Concat(new byte[] { 0xFF, 0xFE }).Concat(Encoding.Unicode.GetBytes("\rmore 50%"))
            .Concat(utf8.GetBytes("ok")).ToArray();
        for (var split = 0; split <= bytes.Length; split++)
        {
            var decoder = new AdaptiveOutputDecoder();
            var text = decoder.Decode(bytes.AsSpan(0, split)) + decoder.Decode(bytes.AsSpan(split)) + decoder.Flush();
            Assert(text == expected, $"Mixed output changed when split at byte {split}: {JsonSerializer.Serialize(text)}");
        }
        var single = new AdaptiveOutputDecoder();
        var byByte = string.Concat(bytes.Select(value => single.Decode(new[] { value }))) + single.Flush();
        Assert(byByte == expected, "Mixed output changed when read one byte at a time: " + JsonSerializer.Serialize(byByte));
        // Progress must not wait for a later read: whole writes decode immediately.
        var live = new AdaptiveOutputDecoder();
        Assert(live.Decode(utf8.GetBytes("\rScan 42%")) == "\rScan 42%", "UTF-8 progress was held back.");
        Assert(live.Decode(Encoding.Unicode.GetBytes("\rScan 43%")) == "\rScan 43%", "UTF-16 progress was held back.");
        var unicodeOnly = string.Concat(Enumerable.Repeat("0123456789αβ中文🙂\r\n", 200));
        var plain = new AdaptiveOutputDecoder();
        var unicodeBytes = utf8.GetBytes(unicodeOnly);
        var decoded = new StringBuilder();
        for (var offset = 0; offset < unicodeBytes.Length; offset += 7)
            decoded.Append(plain.Decode(unicodeBytes.AsSpan(offset, Math.Min(7, unicodeBytes.Length - offset))));
        Assert(decoded.Append(plain.Flush()).ToString() == unicodeOnly, "Plain UTF-8 Unicode output changed.");
        return Task.CompletedTask;
    }
    private static async Task PowerShellLiveOutputAsync()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = CreateTemp();
        try
        {
            var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var resultTask = new PowerShellRunner().RunScriptAsync("[Console]::Out.Write('first-progress'); [Console]::Out.Flush(); Start-Sleep -Seconds 6; [Console]::Out.Write('last-progress')", directory,
                (_, text) => { if (text.Contains("first-progress", StringComparison.Ordinal)) first.TrySetResult(); return Task.CompletedTask; }, 15, CancellationToken.None);
            var arrived = await Task.WhenAny(first.Task, Task.Delay(2500)) == first.Task;
            var stillRunning = !resultTask.IsCompleted;
            await resultTask;
            Assert(arrived && stillRunning, "Partial output was buffered until the process ended.");
        }
        finally { Directory.Delete(directory, true); }
    }
    private static async Task NativeLiveOutputAsync(string encoding)
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = CreateTemp();
        try
        {
            var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var output = new StringBuilder();
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing test process path.");
            var command = "& '" + executable.Replace("'", "''", StringComparison.Ordinal) + "' ";
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                command += "'" + Path.Combine(AppContext.BaseDirectory, "LibraryRmm.Agent.dll").Replace("'", "''", StringComparison.Ordinal) + "' ";
            command += "--self-test-native-progress " + encoding;
            var resultTask = new PowerShellRunner().RunScriptAsync(command, directory,
                (stream, text) =>
                {
                    if (stream == "stdout")
                    {
                        output.Append(text);
                        if (output.ToString().Contains("native-first-progress", StringComparison.Ordinal)) first.TrySetResult();
                    }
                    return Task.CompletedTask;
                }, 20, CancellationToken.None);
            var arrived = await Task.WhenAny(first.Task, Task.Delay(2500)) == first.Task;
            var stillRunning = !resultTask.IsCompleted;
            var result = await resultTask;
            Assert(arrived && stillRunning, "Native progress was buffered until newline/completion.");
            Assert(result.ExitCode == 0 && !result.Interrupted, "Synthetic native command failed.");
            Assert(!output.ToString().Contains('\0') && output.ToString().Contains("α🙂", StringComparison.Ordinal), "Native Unicode text was corrupted.");
        }
        finally { Directory.Delete(directory, true); }
    }

    internal static async Task RunNativeProgressChildAsync(string encoding)
    {
        if (encoding is not ("utf8" or "utf16le")) throw new ArgumentException("Unknown safe test encoding.");
        var encoder = encoding == "utf16le" ? Encoding.Unicode : new UTF8Encoding(false);
        await using var output = Console.OpenStandardOutput();
        async Task WriteAsync(string text) { await output.WriteAsync(encoder.GetBytes(text)); await output.FlushAsync(); }
        await WriteAsync("\rnative-first-progress α🙂 10%");
        await Task.Delay(4000);
        await WriteAsync("\rnative-second-progress α🙂 50%");
        await Task.Delay(2000);
        await WriteAsync("\rnative-last-progress 100%\r\n");
    }
    private static async Task DeliveryRetryAsync()
    {
        var directory = CreateTemp();
        try
        {
            var configuration = TestConfiguration(directory);
            var spool = new OutputSpool(configuration);
            var job = new AgentJob(Guid.NewGuid().ToString(), "powershell", JsonSerializer.SerializeToElement(new { script = "Write-Output test" }), "test-dispatch", 10);
            var journal = await spool.CreateAsync(job);
            var source = new string('α', 100_000);
            await journal.AppendAsync("stdout", source);
            await journal.CompleteAsync(new JobCompletion("succeeded", 0, "Test completed."));
            var handler = new RecordingHandler { FailOnceAtSequence = 2 };
            using var api = new AgentApi(configuration, handler);
            var deferred = false;
            try { await spool.FlushAsync(api, CancellationToken.None); } catch (AgentApiException) { deferred = true; }
            Assert(deferred && Directory.EnumerateDirectories(spool.Root).Any(), "Failed delivery discarded the journal.");
            Assert(handler.Completion is null, "Completion was sent before all output was accepted.");
            await spool.FlushAsync(api, CancellationToken.None);
            Assert(string.Concat(handler.Chunks.OrderBy(chunk => chunk.Sequence).Select(chunk => chunk.Text)) == source, "Retried delivery lost or duplicated output.");
            Assert(handler.Completion?.Status == "succeeded", "Completion was not delivered after all output.");
        }
        finally { Directory.Delete(directory, true); }
    }
    private static async Task DuplicateJournalAsync()
    {
        var directory = CreateTemp();
        try
        {
            var spool = new OutputSpool(TestConfiguration(directory));
            var job = new AgentJob(Guid.NewGuid().ToString(), "powershell", JsonSerializer.SerializeToElement(new { script = "Write-Output test" }), "test-dispatch", 10);
            var journal = await spool.CreateAsync(job);
            await journal.AppendAsync("stdout", "original output");
            var rejected = false;
            try { await spool.CreateAsync(job); } catch (InvalidOperationException) { rejected = true; }
            Assert(rejected, "Previously seen job was accepted for fresh execution.");
            var chunk = JsonSerializer.Deserialize<OutputChunk>(await File.ReadAllTextAsync(Directory.EnumerateFiles(journal.DirectoryPath, "chunk-*.json").Single()), AgentConfiguration.Json);
            Assert(chunk?.Text == "original output", "Duplicate job replaced its original evidence.");
        }
        finally { Directory.Delete(directory, true); }
    }
    private static async Task PowerShellTimeoutAsync()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = CreateTemp();
        try
        {
            var result = await new PowerShellRunner().RunScriptAsync("Start-Sleep -Seconds 30", directory,
                (_, _) => Task.CompletedTask, 1, CancellationToken.None);
            Assert(result.Interrupted && result.InterruptionReason?.Contains("timed out", StringComparison.Ordinal) == true, "Timeout did not mark the command interrupted.");
        }
        finally { Directory.Delete(directory, true); }
    }
    private static Task StoragePathAsync()
    {
        foreach (var path in new[] { "relative", "\\\\server\\share", "\\\\?\\C:\\", "https://example.test" })
        {
            var rejected = false;
            try { StorageExplorer.ValidateLocalPath(path); } catch (ArgumentException) { rejected = true; }
            Assert(rejected, "Unsafe path accepted.");
        }
        return Task.CompletedTask;
    }
    private static AgentConfiguration TestConfiguration(string directory) => new()
    {
        ServerUrl = "https://example.test", DeviceId = Guid.NewGuid().ToString(), AgentToken = "test-only-token", EndpointId = Guid.NewGuid().ToString(), DataDirectory = directory
    };
    private static string CreateTemp()
    {
        var path = Path.Combine(Path.GetTempPath(), "library-rmm-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    private static Task UpdaterVersionRulesAsync()
    {
        Assert(AgentUpdater.IsNewer("0.1.1", "0.1.0") && AgentUpdater.IsNewer("0.10.0", "0.9.9") && AgentUpdater.IsNewer("1.0.0", "0.1.0-dev"), "Newer version rejected.");
        Assert(!AgentUpdater.IsNewer("0.1.0", "0.1.0") && !AgentUpdater.IsNewer("0.0.9", "0.1.0") && !AgentUpdater.IsNewer("0.2.0-beta", "0.1.0") && !AgentUpdater.IsNewer("x", "0.1.0"),
            "Equal, older, prerelease or malformed version accepted.");
        var sha = new string('a', 64);
        var good = new AgentPackageManifest("0.1.1", "win-x64", sha, 10, AgentUpdater.DownloadPath);
        AgentUpdater.ValidateManifest(good);
        foreach (var bad in new[] { good with { Runtime = "win-arm64" }, good with { DownloadUrl = "https://evil.test/a.zip" }, good with { DownloadUrl = "/downloads/other.zip" },
                     good with { Sha256 = "ABC" }, good with { SizeBytes = 0 }, good with { Version = "latest" } })
        {
            var rejected = false;
            try { AgentUpdater.ValidateManifest(bad); } catch (InvalidDataException) { rejected = true; }
            Assert(rejected, "Unsafe package manifest accepted: " + bad);
        }
        var now = DateTimeOffset.UtcNow;
        Assert(AgentUpdater.MayAttempt(null, good, now), "First attempt refused.");
        Assert(!AgentUpdater.MayAttempt(new("0.1.1", sha, 1, now.AddMinutes(-10)), good, now), "Retry ignored 30-minute backoff.");
        Assert(AgentUpdater.MayAttempt(new("0.1.1", sha, 1, now.AddMinutes(-31)), good, now), "Retry refused after backoff.");
        Assert(!AgentUpdater.MayAttempt(new("0.1.1", sha, 2, now.AddMinutes(-60)), good, now), "Second retry ignored 2-hour backoff.");
        Assert(!AgentUpdater.MayAttempt(new("0.1.1", sha, 3, now.AddDays(-30)), good, now), "Attempt limit ignored.");
        Assert(AgentUpdater.MayAttempt(new("0.1.1", sha, 3, now), good with { Sha256 = new string('b', 64) }, now), "A new package digest was blocked by an old failure.");
        return Task.CompletedTask;
    }

    private static async Task UpdaterManifestRetryAsync()
    {
        var log = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        var manifest = new AgentPackageManifest("0.1.5", "win-x64", new string('a',64), 10, AgentUpdater.DownloadPath);
        var calls = 0; var waits = new List<TimeSpan>();
        Task Wait(TimeSpan duration, CancellationToken ct) { ct.ThrowIfCancellationRequested(); waits.Add(duration); return Task.CompletedTask; }
        var result = await AgentUpdater.FetchManifestWithRetryAsync(() => {
            if (++calls < 3) throw new HttpRequestException("Synthetic network not ready");
            return Task.FromResult(manifest);
        }, log, CancellationToken.None, Wait);
        Assert(result == manifest && calls == 3 && waits.SequenceEqual(new[] {TimeSpan.FromSeconds(5),TimeSpan.FromSeconds(15)}), "Boot networking was not retried safely.");
        calls = 0; waits.Clear();
        try { await AgentUpdater.FetchManifestWithRetryAsync(() => { calls++; throw new HttpRequestException("Offline"); }, log, CancellationToken.None, Wait); }
        catch (HttpRequestException) { }
        Assert(calls == 4 && waits.Count == 3, "Offline startup retries were unbounded.");
        calls = 0;
        try { await AgentUpdater.FetchManifestWithRetryAsync(() => { calls++; throw new InvalidDataException("Unsafe manifest"); }, log, CancellationToken.None, Wait); }
        catch (InvalidDataException) { }
        Assert(calls == 1, "Unsafe manifest was retried.");
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel(); calls = 0;
        try { await AgentUpdater.FetchManifestWithRetryAsync(() => { calls++; return Task.FromResult(manifest); }, log, cancelled.Token, Wait); }
        catch (OperationCanceledException) { }
        Assert(calls == 0, "Stopped service continued updating.");
    }

    private static byte[] BuildPackage(string version, byte[] executable, string? extraEntry = null, string? agentHash = null)
    {
        using var memory = new MemoryStream();
        using (var zip = new System.IO.Compression.ZipArchive(memory, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string name, byte[] data) { using var entry = zip.CreateEntry(name).Open(); entry.Write(data); }
            Add("agent/LibraryRmm.Agent.exe", executable);
            Add("Install-Agent.ps1", Encoding.UTF8.GetBytes("# test installer; never executed by self-tests"));
            Add("package-manifest.json", JsonSerializer.SerializeToUtf8Bytes(new
            {
                version, runtime = "win-x64", agentSha256 = agentHash ?? Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(executable))
            }));
            if (extraEntry is not null) Add(extraEntry, [1, 2, 3]);
        }
        return memory.ToArray();
    }

    private static async Task UpdaterGroupPolicyAsync()
    {
        var executable = Encoding.UTF8.GetBytes("not a real executable");
        var package = BuildPackage("0.9.0", executable);
        var digest = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(package));
        AgentPackageManifest Manifest() => new("0.9.0", "win-x64", digest, package.Length, AgentUpdater.DownloadPath);
        foreach (var allowed in new[] { false, true })
        {
            var directory = CreateTemp();
            try
            {
                var handler = new PackageHandler(package, Manifest()) { ScopedAutoUpdate = allowed };
                using var updater = new AgentUpdater(TestConfiguration(directory), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, handler);
                var staged = await updater.PrepareAsync("0.1.0", CancellationToken.None);
                Assert(handler.Paths.FirstOrDefault() == "/api/agent/update-manifest" && handler.ScopedAuthorization == "Bearer test-only-token", "Updater did not ask for its own manifest with its credential.");
                Assert(!handler.Paths.Contains("/api/agent-download"), "Updater fell back to the anonymous manifest although the scoped one answered.");
                if (allowed) Assert(staged is not null && handler.Downloads == 1, "Allowed group did not update.");
                else Assert(staged is null && handler.Downloads == 0 && updater.ReadState() is null, "Group with automatic updates off still downloaded or recorded an attempt.");
            }
            finally { Directory.Delete(directory, true); }
        }
        // An older server (404 on the scoped route) falls back to the anonymous manifest.
        var oldServer = CreateTemp();
        try
        {
            var handler = new PackageHandler(package, Manifest());
            using var updater = new AgentUpdater(TestConfiguration(oldServer), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, handler);
            Assert(await updater.PrepareAsync("0.1.0", CancellationToken.None) is not null && handler.Paths.Contains("/api/agent-download"), "Older server without the scoped route did not fall back.");
        }
        finally { Directory.Delete(oldServer, true); }
        // Any other refusal (e.g. revoked credential) never falls back to the anonymous manifest.
        var revoked = CreateTemp();
        try
        {
            var handler = new PackageHandler(package, Manifest()) { ScopedStatus = HttpStatusCode.Unauthorized };
            using var updater = new AgentUpdater(TestConfiguration(revoked), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, handler);
            var refused = false;
            try { await updater.PrepareAsync("0.1.0", CancellationToken.None); } catch (AgentApiException) { refused = true; }
            Assert(refused && handler.Downloads == 0 && !handler.Paths.Contains("/api/agent-download"), "A refused credential fell back to the anonymous manifest.");
        }
        finally { Directory.Delete(revoked, true); }
    }

    private static async Task UpdaterStagingAsync()
    {
        var directory = CreateTemp();
        try
        {
            var executable = Encoding.UTF8.GetBytes("not a real executable");
            var package = BuildPackage("0.9.0", executable);
            var handler = new PackageHandler(package, new AgentPackageManifest("0.9.0", "win-x64",
                Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(package)), package.Length, AgentUpdater.DownloadPath));
            var now = DateTimeOffset.UtcNow;
            using var updater = new AgentUpdater(TestConfiguration(directory), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, handler, () => now);
            Assert(await updater.PrepareAsync("0.9.0", CancellationToken.None) is null && handler.Downloads == 0, "Equal version downloaded a package.");
            var staged = await updater.PrepareAsync("0.1.0", CancellationToken.None);
            Assert(staged is not null && File.ReadAllBytes(Path.Combine(staged.Directory, "agent", "LibraryRmm.Agent.exe")).SequenceEqual(executable), "Verified package was not staged.");
            Assert(updater.ReadState() is { Attempts: 1, Version: "0.9.0" }, "Attempt was not persisted.");
            Assert(handler.Paths.All(path => path is "/api/agent/update-manifest" or "/api/agent-download" or AgentUpdater.DownloadPath), "Updater contacted an unexpected path.");
            Assert(await updater.PrepareAsync("0.1.0", CancellationToken.None) is null && handler.Downloads == 1, "Immediate retry ignored backoff (restart loop risk).");

            // Tampered archive: digest mismatch is rejected and nothing is staged.
            var tamperDirectory = CreateTemp();
            try
            {
                var tampered = (byte[])package.Clone();
                tampered[^5] ^= 0xFF;
                var badHandler = new PackageHandler(tampered, handler.Manifest);
                using var badUpdater = new AgentUpdater(TestConfiguration(tamperDirectory), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, badHandler);
                var rejected = false;
                try { await badUpdater.PrepareAsync("0.1.0", CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
                Assert(rejected && Directory.GetDirectories(Path.Combine(tamperDirectory, "updates")).Length == 0, "Tampered package was staged.");
                Assert(badUpdater.ReadState() is { Attempts: 1 }, "Failed attempt was not counted.");
            }
            finally { Directory.Delete(tamperDirectory, true); }

            // Path traversal, inner version mismatch and executable hash mismatch are refused.
            foreach (var (bytes, label) in new[]
                     {
                         (BuildPackage("0.9.0", executable, extraEntry: "../escaped.txt"), "traversal"),
                         (BuildPackage("0.8.0", executable), "inner version"),
                         (BuildPackage("0.9.0", executable, agentHash: new string('0', 64)), "executable hash")
                     })
            {
                var archive = Path.Combine(directory, label.Replace(' ', '-') + ".zip");
                File.WriteAllBytes(archive, bytes);
                var target = Path.Combine(directory, "extract-" + label.Replace(' ', '-'));
                var refused = false;
                try { AgentUpdater.ExtractVerified(archive, target, "0.9.0"); } catch (InvalidDataException) { refused = true; }
                Assert(refused && !File.Exists(Path.Combine(directory, "escaped.txt")), $"Unsafe package ({label}) accepted.");
            }
        }
        finally { Directory.Delete(directory, true); }
    }

    private static async Task JoinApprovalAsync()
    {
        var directory = CreateTemp();
        try
        {
            var deviceId = Guid.NewGuid().ToString();
            var secret = new string('s', 43);
            var endpointId = Guid.NewGuid().ToString();
            File.WriteAllText(Path.Combine(directory, "agent.json"), JsonSerializer.Serialize(new
            {
                serverUrl = "https://example.test", deviceId, joinSecret = secret, pollSeconds = 10, inventoryMinutes = 15, allowInsecureLocalhost = false
            }));
            var configuration = AgentConfiguration.Load(["--data-dir", directory]);
            Assert(configuration.AwaitingApproval, "Tokenless configuration did not load as awaiting approval.");
            var unauthorized = false;
            try { using var api = new AgentApi(configuration, new RecordingHandler()); await api.CheckInAsync(new { }, CancellationToken.None); }
            catch (InvalidOperationException) { unauthorized = true; }
            Assert(unauthorized, "An unapproved agent attempted an authenticated API call.");

            var responses = new Queue<object>([new { status = "pending" }, new { status = "denied" }, new { status = "approved", endpointId, agentToken = "issued-token" }]);
            var handler = new JoinHandler(responses);
            var waits = new List<TimeSpan>();
            await AgentJoin.WaitForApprovalAsync(configuration, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, CancellationToken.None,
                handler, (wait, _) => { waits.Add(wait); return Task.CompletedTask; });
            Assert(handler.Bodies.Count == 3 && handler.Bodies.All(body => body.Contains(secret, StringComparison.Ordinal) && body.Contains(deviceId, StringComparison.Ordinal)), "Join requests did not carry the device identity.");
            Assert(!handler.SawAuthorization, "Join requests must not send a bearer credential.");
            Assert(waits.SequenceEqual([AgentJoin.PendingInterval, AgentJoin.DeniedInterval]), "Unexpected join polling intervals.");
            Assert(configuration.AgentToken == "issued-token" && configuration.EndpointId == endpointId && !configuration.AwaitingApproval, "Approved credential was not applied.");
            var reloaded = AgentConfiguration.Load(["--data-dir", directory]);
            Assert(reloaded.AgentToken == "issued-token" && reloaded.EndpointId == endpointId && reloaded.JoinSecret == secret && reloaded.DeviceId == deviceId,
                "Approved credential was not persisted with the existing identity.");
        }
        finally { Directory.Delete(directory, true); }
    }

    // ---------- file explorer (temp directories only; never touches real system files) ----------

    private static FileSafetyPolicy TempPolicy(string root) => new(
        protectedTrees: [Path.Combine(root, "agent-install"), Path.Combine(root, "agent-data")],
        protectedRoots: [Path.Combine(root, "protected-root")],
        secretTrees: [Path.Combine(root, "agent-data")]);

    private static async Task<JsonElement> RunFiles(object payload, FileSafetyPolicy policy, IFileTransfer? transfer = null, string? staging = null)
    {
        var outcome = await FileOperations.ExecuteAsync(JsonSerializer.SerializeToElement(payload, AgentConfiguration.Json), policy, transfer, CancellationToken.None, staging);
        var json = JsonDocument.Parse(outcome.Json).RootElement.Clone();
        Assert(json.GetProperty("ok").GetBoolean() == (outcome.Status == "succeeded"), "Outcome status and JSON disagree.");
        return json;
    }

    private static async Task FileOperationsBasicAsync()
    {
        var root = CreateTemp();
        try
        {
            var policy = TempPolicy(root);
            var work = Path.Combine(root, "work");
            Directory.CreateDirectory(Path.Combine(work, "folder", "nested"));
            File.WriteAllText(Path.Combine(work, "folder", "nested", "deep.txt"), "deep");
            File.WriteAllText(Path.Combine(work, "a.txt"), "alpha");
            File.WriteAllText(Path.Combine(work, "h.txt"), "hidden");
            File.SetAttributes(Path.Combine(work, "h.txt"), FileAttributes.Hidden);

            var listed = await RunFiles(new { action = "list", path = work }, policy);
            var entries = listed.GetProperty("entries").EnumerateArray().ToDictionary(entry => entry.GetProperty("name").GetString()!);
            Assert(entries.Count == 3 && entries["a.txt"].GetProperty("size").GetInt64() == 5 && entries["h.txt"].GetProperty("hidden").GetBoolean()
                && !entries["a.txt"].GetProperty("hidden").GetBoolean() && entries["folder"].GetProperty("type").GetString() == "directory"
                && listed.GetProperty("parent").GetString() == root, "Listing is missing entries, sizes, attributes or parent.");
            var drives = await RunFiles(new { action = "list", path = "" }, policy);
            Assert(drives.GetProperty("drives").GetArrayLength() > 0, "Drive list is empty.");
            Assert(!(await RunFiles(new { action = "list", path = Path.Combine(work, "missing") }, policy)).GetProperty("ok").GetBoolean(), "Missing folder listed.");

            Assert((await RunFiles(new { action = "mkdir", path = Path.Combine(work, "made") }, policy)).GetProperty("ok").GetBoolean() && Directory.Exists(Path.Combine(work, "made")), "mkdir failed.");
            Assert(!(await RunFiles(new { action = "mkdir", path = Path.Combine(work, "made") }, policy)).GetProperty("ok").GetBoolean(), "mkdir replaced an existing folder.");
            Assert(!(await RunFiles(new { action = "mkdir", path = Path.Combine(work, "no-parent", "child") }, policy)).GetProperty("ok").GetBoolean(), "mkdir created missing parents.");

            var copied = await RunFiles(new { action = "copy", sources = new[] { Path.Combine(work, "a.txt"), Path.Combine(work, "folder") }, destinationDirectory = Path.Combine(work, "made") }, policy);
            Assert(copied.GetProperty("succeeded").GetInt32() == 2 && File.ReadAllText(Path.Combine(work, "made", "folder", "nested", "deep.txt")) == "deep"
                && File.Exists(Path.Combine(work, "a.txt")), "Copy did not duplicate files and folders.");
            var conflict = await RunFiles(new { action = "copy", sources = new[] { Path.Combine(work, "a.txt") }, destinationDirectory = Path.Combine(work, "made") }, policy);
            Assert(conflict.GetProperty("failed").GetInt32() == 1, "Copy overwrote an existing file without overwrite.");
            File.WriteAllText(Path.Combine(work, "a.txt"), "changed");
            Assert((await RunFiles(new { action = "copy", sources = new[] { Path.Combine(work, "a.txt") }, destinationDirectory = Path.Combine(work, "made"), overwrite = true }, policy)).GetProperty("ok").GetBoolean()
                && File.ReadAllText(Path.Combine(work, "made", "a.txt")) == "changed", "Copy with overwrite failed.");
            var same = await RunFiles(new { action = "copy", sources = new[] { Path.Combine(work, "a.txt") }, destinationDirectory = work }, policy);
            Assert(same.GetProperty("ok").GetBoolean() && File.Exists(Path.Combine(work, "a - Copy.txt")), "Paste into the same folder did not create a copy.");
            Assert((await RunFiles(new { action = "copy", sources = new[] { Path.Combine(work, "folder") }, destinationDirectory = Path.Combine(work, "folder", "nested") }, policy)).GetProperty("failed").GetInt32() == 1,
                "A folder was copied into itself.");

            var moved = await RunFiles(new { action = "move", sources = new[] { Path.Combine(work, "a - Copy.txt"), Path.Combine(work, "missing.txt") }, destinationDirectory = Path.Combine(work, "folder") }, policy);
            Assert(moved.GetProperty("succeeded").GetInt32() == 1 && moved.GetProperty("failed").GetInt32() == 1 && File.Exists(Path.Combine(work, "folder", "a - Copy.txt"))
                && !File.Exists(Path.Combine(work, "a - Copy.txt")), "Move did not report per-item results or keep going after an error.");
            Assert((await RunFiles(new { action = "move", sources = new[] { Path.Combine(work, "folder") }, destinationDirectory = Path.Combine(work, "folder", "nested") }, policy)).GetProperty("failed").GetInt32() == 1,
                "A folder was moved into itself.");

            Assert((await RunFiles(new { action = "rename", path = Path.Combine(work, "made"), newName = "Renamed" }, policy)).GetProperty("ok").GetBoolean() && Directory.Exists(Path.Combine(work, "Renamed")), "Rename failed.");
            Assert((await RunFiles(new { action = "rename", path = Path.Combine(work, "Renamed"), newName = "renamed" }, policy)).GetProperty("ok").GetBoolean()
                && new DirectoryInfo(work).GetDirectories().Any(directory => directory.Name == "renamed"), "Case-only rename failed.");
            foreach (var bad in new[] { "..", "a/b", "x:y", "CON", "trailing.", "" })
                Assert(!(await RunFiles(new { action = "rename", path = Path.Combine(work, "renamed"), newName = bad }, policy)).GetProperty("ok").GetBoolean(), $"Unsafe new name accepted: '{bad}'.");

            var deletion = await RunFiles(new { action = "delete", paths = new[] { Path.Combine(work, "renamed") }, recursive = false }, policy);
            Assert(!deletion.GetProperty("ok").GetBoolean() && Directory.Exists(Path.Combine(work, "renamed")), "Non-recursive delete removed a non-empty folder.");
            File.SetAttributes(Path.Combine(work, "renamed", "a.txt"), FileAttributes.ReadOnly);
            Assert((await RunFiles(new { action = "delete", paths = new[] { Path.Combine(work, "renamed"), Path.Combine(work, "a.txt") }, recursive = true }, policy)).GetProperty("succeeded").GetInt32() == 2
                && !Directory.Exists(Path.Combine(work, "renamed")) && !File.Exists(Path.Combine(work, "a.txt")), "Recursive delete (including a read-only file) failed.");
        }
        finally { ForceDelete(root); }
    }

    private static async Task FileOperationsLinkDeleteAsync()
    {
        var root = CreateTemp();
        try
        {
            var policy = TempPolicy(root);
            var target = Path.Combine(root, "link-target");
            Directory.CreateDirectory(target);
            File.WriteAllText(Path.Combine(target, "keep.txt"), "must survive");
            var tree = Path.Combine(root, "tree");
            Directory.CreateDirectory(tree);
            File.WriteAllText(Path.Combine(tree, "remove.txt"), "x");
            var link = Path.Combine(tree, "link");
            if (!TryCreateDirectoryLink(link, target))
            {
                Console.WriteLine("SKIP link sub-check: creating a junction or symbolic link is not permitted here.");
                return;
            }
            // Copy skips the link instead of following it.
            var copyTarget = Path.Combine(root, "copy");
            Directory.CreateDirectory(copyTarget);
            var copy = await RunFiles(new { action = "copy", sources = new[] { tree }, destinationDirectory = copyTarget }, policy);
            Assert(copy.GetProperty("ok").GetBoolean() && File.Exists(Path.Combine(copyTarget, "tree", "remove.txt")) && !Directory.Exists(Path.Combine(copyTarget, "tree", "link")),
                "Recursive copy followed or copied a link.");
            var listed = await RunFiles(new { action = "list", path = tree }, policy);
            Assert(listed.GetProperty("entries").EnumerateArray().Any(entry => entry.GetProperty("name").GetString() == "link" && entry.GetProperty("reparse").GetBoolean()), "Link not flagged as reparse point.");
            var deleted = await RunFiles(new { action = "delete", paths = new[] { tree }, recursive = true }, policy);
            Assert(deleted.GetProperty("ok").GetBoolean() && !Directory.Exists(tree), "Recursive delete failed.");
            Assert(File.ReadAllText(Path.Combine(target, "keep.txt")) == "must survive", "Recursive delete followed a link and removed its target's contents.");
        }
        finally { ForceDelete(root); }
    }

    private static bool TryCreateDirectoryLink(string link, string target)
    {
        try
        {
            // Junctions need no elevation; fall back to a symbolic link (needs Developer Mode or admin).
            using var process = Process.Start(new ProcessStartInfo("cmd.exe", ["/d", "/c", "mklink", "/J", link, target])
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
            process!.WaitForExit(10000);
            if (Directory.Exists(link) && (new DirectoryInfo(link).Attributes & FileAttributes.ReparsePoint) != 0) return true;
        }
        catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException) { }
        try { Directory.CreateSymbolicLink(link, target); return true; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return false; }
    }

    private static async Task FileOperationsSafetyAsync()
    {
        // The real agent policy: pure path checks, no file system access.
        var real = FileSafetyPolicy.ForAgent(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LibraryRmm"));
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        foreach (var path in new[] { "C:\\", "D:\\", windows, Path.Combine(windows, "System32", "library-rmm-never-exists.dll"), programFiles, programData,
                     Path.Combine(programFiles, "LibraryRmm"), Path.Combine(programFiles, "LibraryRmm", "LibraryRmm.Agent.exe"), Path.Combine(programData, "LibraryRmm", "agent.json"),
                     Path.Combine(Path.GetPathRoot(windows)!, "Users"), AppContext.BaseDirectory })
        {
            var refused = false;
            try { real.EnsureMutable(FileOperations.ValidatePath(path)); } catch (UnauthorizedAccessException) { refused = true; }
            Assert(refused, $"Protected path was not refused: {path}");
        }
        var destinationRefused = false;
        try { real.EnsureWritableDestination(Path.Combine(windows, "Temp")); } catch (UnauthorizedAccessException) { destinationRefused = true; }
        Assert(destinationRefused, "Files could be placed inside the Windows folder.");
        var secretRefused = false;
        try { real.EnsureReadable(Path.Combine(programData, "LibraryRmm", "agent.json")); } catch (UnauthorizedAccessException) { secretRefused = true; }
        Assert(secretRefused, "The agent credential file could be read remotely.");
        real.EnsureMutable(Path.Combine(programFiles, "Some Old App")); // children of Program Files remain manageable
        foreach (var path in new[] { "relative\\x", "\\\\server\\share\\x", "\\\\?\\C:\\x", "\\\\.\\PhysicalDrive0", "C:\\x\\file.txt:stream", "C:\\x\\*.txt", "C:\\x\\NUL", "C:\\x\\con.txt", "https://example.test/x" })
        {
            var rejected = false;
            try { FileOperations.ValidatePath(path); } catch (ArgumentException) { rejected = true; }
            Assert(rejected, $"Unsafe path accepted: {path}");
        }

        // End to end with a temp policy: refusals keep going per item and change nothing.
        var root = CreateTemp();
        try
        {
            var policy = TempPolicy(root);
            var data = Path.Combine(root, "agent-data");
            Directory.CreateDirectory(data);
            File.WriteAllText(Path.Combine(data, "agent.json"), "{\"agentToken\":\"secret\"}");
            Directory.CreateDirectory(Path.Combine(root, "protected-root", "child"));
            File.WriteAllText(Path.Combine(root, "free.txt"), "ok");
            var result = await RunFiles(new { action = "delete", paths = new[] { data, Path.Combine(data, "agent.json"), Path.Combine(root, "protected-root"), root, Path.Combine(root, "free.txt") }, recursive = true }, policy);
            Assert(result.GetProperty("succeeded").GetInt32() == 1 && result.GetProperty("failed").GetInt32() == 4 && File.Exists(Path.Combine(data, "agent.json"))
                && Directory.Exists(Path.Combine(root, "protected-root")) && !File.Exists(Path.Combine(root, "free.txt")), "Protected deletes were not refused per item.");
            Assert((await RunFiles(new { action = "delete", paths = new[] { Path.Combine(root, "protected-root", "child") }, recursive = true }, policy)).GetProperty("ok").GetBoolean(),
                "Children of a protected root could not be managed.");
            Assert(!(await RunFiles(new { action = "download", path = Path.Combine(data, "agent.json") }, policy, new MemoryTransfer())).GetProperty("ok").GetBoolean(), "Agent credential was downloadable.");
            Assert((await RunFiles(new { action = "copy", sources = new[] { Path.Combine(data, "agent.json") }, destinationDirectory = root }, policy)).GetProperty("failed").GetInt32() == 1
                && !File.Exists(Path.Combine(root, "agent.json")), "Agent credential could be copied out.");
            Assert(!(await RunFiles(new { action = "mkdir", path = Path.Combine(data, "x") }, policy)).GetProperty("ok").GetBoolean(), "Folder created inside the agent data tree.");
            Assert(!(await RunFiles(new { action = "copy", sources = new[] { Path.Combine(root, "protected-root") }, destinationDirectory = data }, policy)).GetProperty("ok").GetBoolean(), "Copy into the agent data tree.");
            Assert(!(await RunFiles(new { action = "teleport", path = root }, policy)).GetProperty("ok").GetBoolean(), "Unknown action accepted.");
        }
        finally { ForceDelete(root); }
    }

    private sealed class MemoryTransfer : IFileTransfer
    {
        public List<(long Sequence, byte[] Data)> Chunks { get; } = [];
        public (string Name, long Size, string Sha256, long Chunks)? Finished { get; private set; }
        public Task UploadChunkAsync(long sequence, ReadOnlyMemory<byte> data, CancellationToken ct) { Chunks.Add((sequence, data.ToArray())); return Task.CompletedTask; }
        public Task FinishAsync(string name, long sizeBytes, string sha256, long chunks, CancellationToken ct) { Finished = (name, sizeBytes, sha256, chunks); return Task.CompletedTask; }
        /// <summary>Bytes the "server" holds for an upload job.</summary>
        public byte[] UploadSource { get; init; } = [];
        public List<(long Offset, int Length)> UploadReads { get; } = [];
        public Task<int> ReadUploadAsync(long offset, Memory<byte> buffer, CancellationToken ct)
        {
            UploadReads.Add((offset, buffer.Length));
            var count = (int)Math.Min(buffer.Length, Math.Max(0, UploadSource.Length - offset));
            UploadSource.AsMemory((int)offset, count).CopyTo(buffer);
            return Task.FromResult(count);
        }
    }

    private static async Task FileOperationsUploadAsync()
    {
        var root = NativePaths.FinalPath(CreateTemp());
        try
        {
            var policy = TempPolicy(root);
            var destination = Path.Combine(root, "dest");
            Directory.CreateDirectory(destination);
            var bytes = new byte[FileOperations.TransferChunkBytes * 2 + 5];
            new Random(5).NextBytes(bytes);
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
            object Payload(string folder, bool overwrite = false, string? hash = null, string name = "setup ü.exe", long? size = null) =>
                new { action = "upload", uploadId = Guid.NewGuid().ToString(), name, sizeBytes = size ?? bytes.Length, sha256 = hash ?? sha, destinationDirectory = folder, overwrite };
            var target = Path.Combine(destination, "setup ü.exe");

            var transfer = new MemoryTransfer { UploadSource = bytes };
            var saved = await RunFiles(Payload(destination), policy, transfer);
            Assert(saved.GetProperty("ok").GetBoolean() && File.ReadAllBytes(target).SequenceEqual(bytes), "Uploaded bytes were not saved exactly.");
            Assert(transfer.UploadReads.Select(read => read.Offset).SequenceEqual([0L, FileOperations.TransferChunkBytes, FileOperations.TransferChunkBytes * 2L]), "Upload was not read in order.");
            Assert((File.GetAttributes(target) & FileAttributes.Hidden) == 0, "Saved file kept the temporary hidden attribute.");

            var conflict = await RunFiles(Payload(destination), policy, new MemoryTransfer { UploadSource = bytes });
            Assert(!conflict.GetProperty("ok").GetBoolean() && conflict.GetProperty("error").GetString()!.Contains("already exists"), "Existing file was replaced without overwrite.");
            var newer = bytes.Reverse().ToArray();
            var newerSha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(newer));
            File.SetAttributes(target, FileAttributes.ReadOnly);
            var replaced = await RunFiles(Payload(destination, overwrite: true, hash: newerSha), policy, new MemoryTransfer { UploadSource = newer });
            Assert(replaced.GetProperty("replaced").GetBoolean() && File.ReadAllBytes(target).SequenceEqual(newer), "Overwrite did not replace a read-only file.");

            // A corrupted transfer never replaces anything and leaves no partial file behind.
            var corrupt = await RunFiles(Payload(destination, overwrite: true, hash: sha), policy, new MemoryTransfer { UploadSource = newer });
            Assert(!corrupt.GetProperty("ok").GetBoolean() && File.ReadAllBytes(target).SequenceEqual(newer), "A SHA-256 mismatch changed the file.");
            var shortTransfer = await RunFiles(Payload(destination, overwrite: true), policy, new MemoryTransfer { UploadSource = bytes[..100] });
            Assert(!shortTransfer.GetProperty("ok").GetBoolean(), "A truncated transfer was accepted.");
            Assert(!Directory.EnumerateFiles(destination, "*.partial", new EnumerationOptions { AttributesToSkip = 0 }).Any(), "Temporary upload files were left behind.");

            var empty = await RunFiles(Payload(destination, name: "empty.txt", size: 0, hash: Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData([]))), policy, new MemoryTransfer());
            Assert(empty.GetProperty("ok").GetBoolean() && new FileInfo(Path.Combine(destination, "empty.txt")).Length == 0, "Empty upload failed.");

            // Protected folders, unsafe names, links and junction tricks are refused.
            var data = Path.Combine(root, "agent-data");
            Directory.CreateDirectory(Path.Combine(data, "sub"));
            Assert(!(await RunFiles(Payload(data), policy, new MemoryTransfer { UploadSource = bytes })).GetProperty("ok").GetBoolean(), "Upload into the agent data folder.");
            Assert(!(await RunFiles(Payload(destination, name: "..\\escape.exe"), policy, new MemoryTransfer { UploadSource = bytes })).GetProperty("ok").GetBoolean(), "Unsafe upload name accepted.");
            if (TryCreateDirectoryLink(Path.Combine(root, "sneaky"), data))
            {
                Assert(!(await RunFiles(Payload(Path.Combine(root, "sneaky")), policy, new MemoryTransfer { UploadSource = bytes })).GetProperty("ok").GetBoolean(), "Upload through a junction.");
                Assert(!(await RunFiles(Payload(Path.Combine(root, "sneaky", "sub")), policy, new MemoryTransfer { UploadSource = bytes })).GetProperty("ok").GetBoolean()
                    && !File.Exists(Path.Combine(data, "sub", "setup ü.exe")), "Upload reached the agent data folder through a junction ancestor.");
                Directory.Delete(Path.Combine(root, "sneaky"), recursive: false);
            }
        }
        finally { ForceDelete(root); }
    }

    private static byte[] BuildZip(Action<System.IO.Compression.ZipArchive> fill)
    {
        using var memory = new MemoryStream();
        using (var zip = new System.IO.Compression.ZipArchive(memory, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true)) fill(zip);
        return memory.ToArray();
    }

    private static void AddEntry(System.IO.Compression.ZipArchive zip, string name, byte[] content)
    {
        using var stream = zip.CreateEntry(name).Open();
        stream.Write(content);
    }

    private static async Task FileOperationsExtractAsync()
    {
        var root = NativePaths.FinalPath(CreateTemp());
        try
        {
            var policy = TempPolicy(root);
            var big = new byte[3 * 1024 * 1024];
            new Random(3).NextBytes(big);
            var zipBytes = BuildZip(zip =>
            {
                AddEntry(zip, "a.txt", Encoding.UTF8.GetBytes("alpha"));
                AddEntry(zip, "dir/b ü.txt", Encoding.UTF8.GetBytes("beta"));
                AddEntry(zip, "dir/big.bin", big);
                zip.CreateEntry("dir/empty/");
                foreach (var evil in new[] { "../evil.txt", "dir/../../evil2.txt", "C:/abs.txt", "/rooted.txt", "x/con.txt", "ads.txt:stream", "link/inside.txt" })
                    AddEntry(zip, evil, Encoding.UTF8.GetBytes("evil"));
                AddEntry(zip, "bomb.txt", new byte[1024 * 1024]);
            });
            // Make bomb.txt claim to be 10 bytes in the central directory while really holding 1 MiB.
            var name = Encoding.UTF8.GetBytes("bomb.txt");
            for (var index = 0; index < zipBytes.Length - 46; index++)
                if (zipBytes[index] == 0x50 && zipBytes[index + 1] == 0x4b && zipBytes[index + 2] == 1 && zipBytes[index + 3] == 2
                    && zipBytes.AsSpan(index + 46, name.Length).SequenceEqual(name))
                    BitConverter.GetBytes(10u).CopyTo(zipBytes, index + 24);
            var zipPath = Path.Combine(root, "package.zip");
            File.WriteAllBytes(zipPath, zipBytes);
            var output = Path.Combine(root, "out");

            var first = await RunFiles(new { action = "extract", path = zipPath, destinationDirectory = output }, policy);
            Assert(File.ReadAllText(Path.Combine(output, "a.txt")) == "alpha" && File.ReadAllText(Path.Combine(output, "dir", "b ü.txt")) == "beta"
                && File.ReadAllBytes(Path.Combine(output, "dir", "big.bin")).SequenceEqual(big) && Directory.Exists(Path.Combine(output, "dir", "empty")), "Zip contents were not extracted exactly.");
            Assert(!File.Exists(Path.Combine(root, "evil.txt")) && !File.Exists(Path.Combine(Path.GetDirectoryName(root)!, "evil2.txt")) && !File.Exists("C:\\abs.txt") && !File.Exists("C:\\rooted.txt"),
                "A zip-slip entry escaped the destination.");
            Assert(!File.Exists(Path.Combine(output, "bomb.txt")), "An entry whose real size differs from the declared size was extracted.");
            Assert(Crc32.Finish(Crc32.Append(Crc32.Start, "123456789"u8)) == 0xCBF43926u, "CRC-32 check value is wrong.");
            var failedPaths = first.GetProperty("results").EnumerateArray().Select(item => item.GetProperty("path").GetString()!).ToArray();
            Assert(!first.GetProperty("ok").GetBoolean() && first.GetProperty("files").GetInt32() == 4 && failedPaths.Length == 7
                && failedPaths.Any(path => path.EndsWith("bomb.txt")) && failedPaths.Contains("../evil.txt"), $"Unexpected extract result: {string.Join(" | ", failedPaths)}");
            Assert(!Directory.EnumerateFiles(output, "*.partial", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 }).Any(), "Temporary extract files were left behind.");

            // Existing files: reported without overwrite, replaced with it.
            File.WriteAllText(Path.Combine(output, "a.txt"), "changed");
            var again = await RunFiles(new { action = "extract", path = zipPath, destinationDirectory = output }, policy);
            Assert(File.ReadAllText(Path.Combine(output, "a.txt")) == "changed" && again.GetProperty("results").EnumerateArray().Any(item => item.GetProperty("error").GetString()!.Contains("already exists")),
                "Existing file was replaced without overwrite.");
            await RunFiles(new { action = "extract", path = zipPath, destinationDirectory = output, overwrite = true }, policy);
            Assert(File.ReadAllText(Path.Combine(output, "a.txt")) == "alpha", "Overwrite did not replace the file.");

            // Never through a link inside the destination, and never into protected folders.
            var data = Path.Combine(root, "agent-data");
            Directory.CreateDirectory(data);
            Directory.Delete(Path.Combine(output, "link"), recursive: true); // the first extract created it as a plain folder
            if (TryCreateDirectoryLink(Path.Combine(output, "link"), data))
            {
                await RunFiles(new { action = "extract", path = zipPath, destinationDirectory = output, overwrite = true }, policy);
                Assert(!File.Exists(Path.Combine(data, "inside.txt")), "Extraction followed a junction into the agent data folder.");
                Directory.Delete(Path.Combine(output, "link"), recursive: false);
            }
            Assert(!(await RunFiles(new { action = "extract", path = zipPath, destinationDirectory = Path.Combine(data, "x") }, policy)).GetProperty("ok").GetBoolean()
                && !Directory.Exists(Path.Combine(data, "x")), "Extracted into the agent data folder.");
            File.WriteAllText(Path.Combine(root, "not-a-zip.zip"), "plain text");
            Assert(!(await RunFiles(new { action = "extract", path = Path.Combine(root, "not-a-zip.zip"), destinationDirectory = Path.Combine(root, "bad") }, policy)).GetProperty("ok").GetBoolean()
                && !Directory.Exists(Path.Combine(root, "bad")), "A damaged zip created output.");
            foreach (var bad in new[] { "..\\x", "a\\..\\..\\x", "C:\\x", "x:y", "con" })
            {
                var refused = false;
                try { FileOperations.EntryTarget(output, bad); } catch (ArgumentException) { refused = true; }
                Assert(refused, $"Unsafe zip entry accepted: {bad}");
            }
        }
        finally { ForceDelete(root); }
    }

    private static async Task FileOperationsDownloadAsync()
    {
        var root = CreateTemp();
        try
        {
            var bytes = new byte[FileOperations.TransferChunkBytes * 2 + 12345];
            new Random(7).NextBytes(bytes);
            var file = Path.Combine(root, "report αβ.bin");
            File.WriteAllBytes(file, bytes);
            var transfer = new MemoryTransfer();
            var result = await RunFiles(new { action = "download", path = file }, TempPolicy(root), transfer);
            var received = transfer.Chunks.OrderBy(chunk => chunk.Sequence).SelectMany(chunk => chunk.Data).ToArray();
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
            Assert(result.GetProperty("ok").GetBoolean() && transfer.Chunks.Count == 3 && transfer.Chunks.Select(chunk => chunk.Sequence).SequenceEqual([0L, 1L, 2L]), "Download was not chunked in sequence.");
            Assert(received.SequenceEqual(bytes) && transfer.Finished == ("report αβ.bin", bytes.Length, sha, 3L), "Downloaded bytes or SHA-256 differ.");
            var empty = Path.Combine(root, "empty.txt");
            File.WriteAllBytes(empty, []);
            var emptyTransfer = new MemoryTransfer();
            Assert((await RunFiles(new { action = "download", path = empty }, TempPolicy(root), emptyTransfer)).GetProperty("ok").GetBoolean()
                && emptyTransfer.Chunks.Count == 0 && emptyTransfer.Finished?.Size == 0, "Empty file download failed.");
        }
        finally { ForceDelete(root); }
    }

    private static async Task FileOperationsFolderDownloadAsync()
    {
        var root = CreateTemp();
        try
        {
            var policy = TempPolicy(root);
            var staging = Path.Combine(root, "agent-data", "download-staging");
            var folder = Path.Combine(root, "Reports αβ");
            Directory.CreateDirectory(Path.Combine(folder, "2026", "empty"));
            var big = new byte[FileOperations.TransferChunkBytes * 3 + 999];
            new Random(11).NextBytes(big);
            File.WriteAllBytes(Path.Combine(folder, "2026", "random.bin"), big);
            File.WriteAllText(Path.Combine(folder, "notes ü.txt"), "hello zip");
            File.WriteAllText(Path.Combine(folder, "locked.txt"), "in use");
            File.SetAttributes(Path.Combine(folder, "notes ü.txt"), FileAttributes.ReadOnly | FileAttributes.Hidden);
            // A nested agent data tree must never be included.
            var nestedSecret = Path.Combine(folder, "agent-data-elsewhere");
            var secretPolicy = new FileSafetyPolicy([], [], [Path.Combine(root, "agent-data"), nestedSecret]);
            Directory.CreateDirectory(nestedSecret);
            File.WriteAllText(Path.Combine(nestedSecret, "agent.json"), "{\"agentToken\":\"secret\"}");
            var outside = Path.Combine(root, "outside");
            Directory.CreateDirectory(outside);
            File.WriteAllText(Path.Combine(outside, "not-mine.txt"), "must not be followed");
            var linked = TryCreateDirectoryLink(Path.Combine(folder, "link"), outside);

            var transfer = new MemoryTransfer();
            JsonElement result;
            // An exclusively opened file cannot be read; it is left out and listed, not a failure.
            using (new FileStream(Path.Combine(folder, "locked.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                var outcome = await FileOperations.ExecuteAsync(JsonSerializer.SerializeToElement(new { action = "download", path = folder }, AgentConfiguration.Json),
                    secretPolicy, transfer, CancellationToken.None, staging);
                Assert(outcome.Status == "succeeded", $"Folder download failed: {outcome.Summary}");
                result = JsonDocument.Parse(outcome.Json).RootElement.Clone();
            }
            var bytes = transfer.Chunks.OrderBy(chunk => chunk.Sequence).SelectMany(chunk => chunk.Data).ToArray();
            Assert(transfer.Chunks.Select(chunk => chunk.Sequence).SequenceEqual(Enumerable.Range(0, transfer.Chunks.Count).Select(index => (long)index)), "Zip chunks were not sent in sequence.");
            Assert(transfer.Finished is { } finished && finished.Name == "Reports αβ.zip" && finished.Size == bytes.Length
                && finished.Sha256 == Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)), "Zip name, size or SHA-256 is wrong.");
            Assert(result.GetProperty("archive").GetBoolean() && result.GetProperty("files").GetInt32() == 2 && result.GetProperty("name").GetString() == "Reports αβ.zip", "Folder result is wrong.");

            using (var zip = new System.IO.Compression.ZipArchive(new MemoryStream(bytes), System.IO.Compression.ZipArchiveMode.Read))
            {
                var names = zip.Entries.Select(entry => entry.FullName).ToHashSet();
                foreach (var expected in new[] { "Reports αβ/", "Reports αβ/2026/", "Reports αβ/2026/empty/", "Reports αβ/2026/random.bin", "Reports αβ/notes ü.txt" })
                    Assert(names.Contains(expected), $"Zip is missing {expected}.");
                Assert(!names.Any(name => name.Contains("agent-data-elsewhere") || name.Contains("link") || name.Contains("locked") || name.Contains("not-mine")),
                    $"Zip contains an excluded item: {string.Join(", ", names)}");
                using var memory = new MemoryStream();
                using (var stream = zip.GetEntry("Reports αβ/2026/random.bin")!.Open()) stream.CopyTo(memory);
                Assert(memory.ToArray().SequenceEqual(big), "Zipped file content differs.");
                using var reader = new StreamReader(zip.GetEntry("Reports αβ/notes ü.txt")!.Open());
                Assert(reader.ReadToEnd() == "hello zip", "Zipped text differs.");
            }
            var skipped = result.GetProperty("skipped").EnumerateArray().Select(item => item.GetProperty("path").GetString()!).ToArray();
            Assert(skipped.Contains(Path.Combine(folder, "locked.txt")) && skipped.Contains(nestedSecret) && (!linked || skipped.Contains(Path.Combine(folder, "link")))
                && result.GetProperty("skippedCount").GetInt32() == skipped.Length, $"Left-out items were not all reported: {string.Join(", ", skipped)}");
            Assert(!Directory.EnumerateFiles(staging).Any(), "The temporary zip was not removed.");

            // Refusals: drive roots, links, the agent data tree itself.
            Assert(!(await RunFiles(new { action = "download", path = Path.GetPathRoot(root)! }, policy, new MemoryTransfer())).GetProperty("ok").GetBoolean(), "A whole drive was downloadable.");
            Assert(!(await RunFiles(new { action = "download", path = Path.Combine(root, "agent-data") }, policy, new MemoryTransfer())).GetProperty("ok").GetBoolean(), "The agent data folder was downloadable.");
            if (linked) Assert(!(await RunFiles(new { action = "download", path = Path.Combine(folder, "link") }, policy, new MemoryTransfer())).GetProperty("ok").GetBoolean(), "A folder link was followed.");
            Assert(FileOperations.ArchiveName(new string('x', 255)).Length == 255 && FileOperations.ArchiveName("a.") == "a.zip", "Archive names are not bounded.");

            // An empty folder still produces a valid zip with just its own entry.
            Directory.CreateDirectory(Path.Combine(root, "nothing"));
            var emptyTransfer = new MemoryTransfer();
            var empty = await RunFiles(new { action = "download", path = Path.Combine(root, "nothing") }, policy, emptyTransfer, staging);
            using var emptyZip = new System.IO.Compression.ZipArchive(new MemoryStream(emptyTransfer.Chunks.SelectMany(chunk => chunk.Data).ToArray()));
            Assert(empty.GetProperty("ok").GetBoolean() && emptyZip.Entries.Single().FullName == "nothing/", "Empty folder zip is wrong.");
        }
        finally
        {
            // Remove the link entry itself first so cleanup never walks into its target.
            var link = Path.Combine(root, "Reports αβ", "link");
            if (Directory.Exists(link)) Directory.Delete(link, recursive: false);
            ForceDelete(root);
        }
    }

    private static void ForceDelete(string root)
    {
        foreach (var file in Directory.EnumerateFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 }))
            try { File.SetAttributes(file, FileAttributes.Normal); } catch (IOException) { }
        Directory.Delete(root, true);
    }

    private sealed class JoinHandler(Queue<object> responses) : HttpMessageHandler
    {
        public List<string> Bodies { get; } = [];
        public bool SawAuthorization { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath != "/api/agent/join" || request.RequestUri.Host != "example.test") return new HttpResponseMessage(HttpStatusCode.NotFound);
            SawAuthorization |= request.Headers.Authorization is not null;
            Bodies.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(responses.Dequeue()) };
        }
    }

    private sealed class PackageHandler(byte[] package, AgentPackageManifest manifest) : HttpMessageHandler
    {
        public AgentPackageManifest Manifest => manifest;
        public List<string> Paths { get; } = [];
        public int Downloads { get; private set; }
        // null: behave like an older server without the scoped route (404).
        public bool? ScopedAutoUpdate { get; init; }
        public HttpStatusCode? ScopedStatus { get; init; }
        public string? ScopedAuthorization { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Paths.Add(path);
            if (request.RequestUri.Host != "example.test") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
            if (path == "/api/agent/update-manifest")
            {
                ScopedAuthorization = request.Headers.Authorization?.ToString();
                if (ScopedStatus is { } status) return Task.FromResult(new HttpResponseMessage(status));
                if (ScopedAutoUpdate is not { } allowed) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(manifest with { AutoUpdate = allowed }, options: AgentConfiguration.Json) });
            }
            if (path == "/api/agent-download")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(manifest, options: AgentConfiguration.Json) });
            if (path == AgentUpdater.DownloadPath)
            {
                Downloads++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(package) });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<string> Paths { get; } = [];
        public List<OutputChunk> Chunks { get; } = [];
        public JobCompletion? Completion { get; private set; }
        public long? FailOnceAtSequence { get; set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Paths.Add(path);
            var content = await request.Content!.ReadAsStringAsync(cancellationToken);
            if (path.Contains("/output/", StringComparison.Ordinal))
            {
                var sequence = long.Parse(path.Split('/')[^1], System.Globalization.CultureInfo.InvariantCulture);
                if (FailOnceAtSequence == sequence)
                {
                    FailOnceAtSequence = null;
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
                }
                using var json = JsonDocument.Parse(content);
                Chunks.Add(new OutputChunk(sequence,
                    json.RootElement.GetProperty("stream").GetString()!, json.RootElement.GetProperty("text").GetString()!));
            }
            if (path.EndsWith("/complete", StringComparison.Ordinal)) Completion = JsonSerializer.Deserialize<JobCompletion>(content, AgentConfiguration.Json);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        }
    }
}
