using System.Net;
using System.Text;
using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Dependency-free checks; does not install a service, enroll, or invoke shutdown.</summary>
internal static class AgentSelfTests
{
    public static async Task<int> RunAsync()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("UTF-8 chunks preserve long output and surrogate pairs", ChunkIntegrityAsync),
            ("execution gate requires a fresh true response and never retries", ExecutionGateAsync),
            ("recovery uploads interruption and existing output without replay", RecoveryAsync),
            ("failed output upload retries delivery without losing text", DeliveryRetryAsync),
            ("repeated job ID cannot replace an existing journal", DuplicateJournalAsync),
            ("PowerShell keeps long lines, Unicode and stderr", PowerShellOutputAsync),
            ("PowerShell timeout terminates command and reports interruption", PowerShellTimeoutAsync),
            ("unsafe storage paths are rejected", StoragePathAsync)
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
        }
        finally { Directory.Delete(directory, true); }
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
