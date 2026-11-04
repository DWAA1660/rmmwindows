using System.Text;
using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>
/// Durable delivery journal, never an execution queue. Startup recovery uploads partial output and
/// interruption status only. Server start authorization remains the source of truth after rollback.
/// </summary>
public sealed class OutputSpool
{
    private readonly string root;
    public OutputSpool(AgentConfiguration configuration)
    {
        root = Path.Combine(configuration.DataDirectory, "spool");
        Directory.CreateDirectory(root);
    }
    public string Root => root;

    public async Task<JobJournal> CreateAsync(AgentJob job)
    {
        var directory = Path.Combine(root, Guid.Parse(job.Id).ToString("D"));
        // Existing journal means a previously seen job. Never turn it into fresh execution.
        if (Directory.Exists(directory)) throw new InvalidOperationException("A journal already exists for this job; execution refused.");
        Directory.CreateDirectory(directory);
        await DurableFile.WriteJsonAsync(Path.Combine(directory, "manifest.json"), new JournalManifest(job.Id, job.Kind, DateTimeOffset.UtcNow));
        return new JobJournal(directory);
    }

    public async Task RecoverInterruptedAsync()
    {
        foreach (var directory in Directories())
        {
            if (!File.Exists(Path.Combine(directory, "complete.json")))
                await new JobJournal(directory).CompleteAsync(new JobCompletion("interrupted", null,
                    "Agent restarted before a confirmed completion. Partial output is retained; execution will not be retried."));
        }
    }

    private IEnumerable<string> Directories() => Directory.EnumerateDirectories(root)
        .Where(path => Guid.TryParse(Path.GetFileName(path), out _) && File.Exists(Path.Combine(path, "manifest.json")));

    public async Task FlushAsync(AgentApi api, CancellationToken ct)
    {
        foreach (var directory in Directories())
        {
            ct.ThrowIfCancellationRequested();
            var id = Path.GetFileName(directory);
            // Snapshot completion BEFORE enumerating chunks. A running producer may finalize
            // concurrently; observing a later completion with an older chunk snapshot would
            // acknowledge and remove output that was not uploaded in this pass.
            var completionFile = Path.Combine(directory, "complete.json");
            var completion = File.Exists(completionFile)
                ? JsonSerializer.Deserialize<JobCompletion>(await File.ReadAllTextAsync(completionFile, ct), AgentConfiguration.Json)
                : null;
            // One uploader, a per-job delivery cursor, and server deduplication make retries safe.
            var cursorFile = Path.Combine(directory, "delivered.json");
            var delivered = File.Exists(cursorFile) ? JsonSerializer.Deserialize<long>(await File.ReadAllTextAsync(cursorFile, ct), AgentConfiguration.Json) : -1;
            foreach (var chunkFile in Directory.EnumerateFiles(directory, "chunk-*.json").Order(StringComparer.Ordinal))
            {
                var chunk = JsonSerializer.Deserialize<OutputChunk>(await File.ReadAllTextAsync(chunkFile, ct), AgentConfiguration.Json)
                    ?? throw new InvalidDataException("Invalid output spool chunk.");
                if (chunk.Sequence <= delivered) continue;
                await api.UploadAsync(id, chunk, ct);
                delivered = chunk.Sequence;
                await DurableFile.WriteJsonAsync(cursorFile, delivered);
            }
            if (completion is null) continue;
            try { await api.CompleteAsync(id, completion, ct); }
            catch (AgentApiException exception) when (exception.StatusCode == 409)
            {
                // The server already knows a different terminal outcome (e.g. restored old spool).
                // Keep evidence for an administrator, but never replay its command or completion.
                await DurableFile.WriteJsonAsync(Path.Combine(directory, "server-conflict.json"), new { detectedAt = DateTimeOffset.UtcNow });
                Directory.Move(directory, Path.Combine(root, "conflict-" + id + "-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                continue;
            }
            // Validate the actual target before removing this specific completed spool directory.
            var absolute = Path.GetFullPath(directory);
            if (!absolute.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Refusing cleanup outside the output spool.");
            Directory.Delete(absolute, recursive: true);
        }
    }
}

public sealed class JobJournal
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private long nextSequence;
    public string DirectoryPath { get; }
    public JobJournal(string directory) { DirectoryPath = directory; }

    public async Task AppendAsync(string stream, string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        foreach (var segment in SplitUtf8(text, 16384))
        {
            await gate.WaitAsync();
            try
            {
                var sequence = nextSequence++;
                await DurableFile.WriteJsonAsync(Path.Combine(DirectoryPath, $"chunk-{sequence:D16}.json"), new OutputChunk(sequence, stream, segment));
            }
            finally { gate.Release(); }
        }
    }
    public Task CompleteAsync(JobCompletion completion) => DurableFile.WriteJsonAsync(Path.Combine(DirectoryPath, "complete.json"), completion);

    internal static IEnumerable<string> SplitUtf8(string text, int maxBytes)
    {
        if (maxBytes < 4) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        var builder = new StringBuilder();
        var bytes = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > maxBytes)
            {
                yield return builder.ToString();
                builder.Clear();
                bytes = 0;
            }
            builder.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
        }
        if (builder.Length > 0) yield return builder.ToString();
    }
}

public static class DurableFile
{
    public static async Task WriteJsonAsync<T>(string path, T value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, AgentConfiguration.Json);
        await WriteAsync(path, bytes);
    }
    public static Task WriteTextAsync(string path, string value) => WriteAsync(path, new UTF8Encoding(false).GetBytes(value));
    private static async Task WriteAsync(string path, byte[] bytes)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                await stream.WriteAsync(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
