using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Volatile shell ownership. Server and agent instance IDs prevent reconstructing a
/// previous runspace after restart or rollback; output still uses durable ordinary job journals.</summary>
public sealed class TerminalManager(AgentConfiguration configuration, AgentApi api) : IDisposable
{
    private sealed class Entry(TerminalShell shell, string jobId)
    {
        public TerminalShell Shell { get; } = shell;
        public string LastJob { get; set; } = jobId;
        public bool Executing { get; set; }
    }
    private readonly string instanceId = Guid.NewGuid().ToString("D");
    private readonly object sync = new();
    private readonly Dictionary<string, Entry> entries = [];
    public bool HasActiveSessions { get { lock (sync) return entries.Count > 0; } }
    private readonly HashSet<string> seen = [];
    private Task? guardian;
    // A brief network problem should not destroy an operator's terminal: explicit denial ends shells
    // at once, but only this many consecutive failed checks (about 5 s apart) count as lost authority.
    internal const int MaxConsecutiveValidationFailures = 3;
    private int validationFailures;
    private bool disposed;

    public async Task<ProcessResult> ExecuteAsync(AgentJob job, Func<string, string, Task> output, int timeout, CancellationToken serviceStopping)
    {
        var sessionId = job.Payload.GetProperty("sessionId").GetString();
        if (!Guid.TryParseExact(sessionId, "D", out _)) throw new InvalidDataException("Invalid terminal session.");
        var script = job.Payload.GetProperty("script").GetString();
        if (string.IsNullOrWhiteSpace(script) || script.Length > 262144) throw new InvalidDataException("Invalid terminal command.");
        // Single authorization attempt, additional to ordinary job.Start. An ambiguous response
        // cannot result in sending another command to the PowerShell process.
        var grant = await api.SendAsync<JsonElement>(HttpMethod.Post, $"terminals/{sessionId}/authorize", new { jobId = job.Id, instanceId }, serviceStopping);
        var expiresAt = grant.GetProperty("expiresAt").GetDateTimeOffset();
        if (expiresAt <= DateTimeOffset.UtcNow) throw new InvalidDataException("Terminal expired before execution.");
        Entry? entry;
        bool previouslyEnded;
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            entries.TryGetValue(sessionId!, out entry);
            previouslyEnded = entry is null && !seen.Add(sessionId!);
        }
        try
        {
            if (previouslyEnded) throw new IOException("This terminal ended; open a new terminal. Its state cannot be restored.");
            if (entry is null)
            {
                var shell = await TerminalShell.StartAsync(Path.Combine(configuration.DataDirectory, "terminals", sessionId!), serviceStopping);
                entry = new Entry(shell, job.Id);
                lock (sync)
                {
                    if (disposed) { shell.Dispose(); throw new ObjectDisposedException(nameof(TerminalManager)); }
                    entries.Add(sessionId!, entry);
                    guardian ??= GuardAsync(serviceStopping);
                }
            }
            lock (sync) { entry.Executing = true; entry.LastJob = job.Id; }
            if (expiresAt <= DateTimeOffset.UtcNow) throw new IOException("Terminal expired during process startup; no command was submitted.");
            var seconds = Math.Min(timeout, Math.Max(1, (int)(expiresAt - DateTimeOffset.UtcNow).TotalSeconds));
            var result = await entry.Shell.ExecuteAsync(script, output, seconds, serviceStopping);
            await api.SendAsync<JsonElement>(HttpMethod.Post, $"terminals/{sessionId}/state", new
            {
                jobId = job.Id, instanceId, status = entry.Shell.Ended ? "closed" : "open", workingDirectory = result.WorkingDirectory
            }, serviceStopping);
            return result.Result;
        }
        catch
        {
            entry?.Shell.End();
            try { using var end = new CancellationTokenSource(TimeSpan.FromSeconds(3)); await api.SendAsync<JsonElement>(HttpMethod.Post, $"terminals/{sessionId}/state", new { jobId = job.Id, instanceId, status = "closed" }, end.Token); }
            catch { /* No retries or new execution. Server expiry/revocation still applies. */ }
            throw;
        }
        finally
        {
            lock (sync)
            {
                if (entry is not null)
                {
                    entry.Executing = false;
                    if (entry.Shell.Ended) { entries.Remove(sessionId!); entry.Shell.Dispose(); }
                }
            }
        }
    }
    private async Task GuardAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
                KeyValuePair<string, Entry>[] snapshot;
                lock (sync) { if (disposed) return; snapshot = entries.ToArray(); }
                if (snapshot.Length == 0) continue;
                HashSet<string> allowed;
                try
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(5));
                    var result = await api.SendAsync<JsonElement>(HttpMethod.Post, "terminals/validate", new { instanceId, sessionIds = snapshot.Select(pair => pair.Key).ToArray() }, deadline.Token);
                    allowed = result.GetProperty("allowed").EnumerateArray().Select(item => item.GetString()!).ToHashSet(StringComparer.Ordinal);
                    validationFailures = 0;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (AgentApiException exception) when (exception.StatusCode is 401 or 403)
                {
                    allowed = []; // The server explicitly refused this agent: end every shell now.
                }
                catch
                {
                    // Network/server hiccup: keep shells for a few checks, then treat it as lost
                    // authority. Shells are ended, never reconnected or recreated.
                    if (++validationFailures < MaxConsecutiveValidationFailures) continue;
                    allowed = [];
                }
                foreach (var pair in snapshot)
                {
                    lock (sync)
                    {
                        if (!allowed.Contains(pair.Key) || pair.Value.Shell.Ended) pair.Value.Shell.End();
                    }
                    if (!pair.Value.Shell.Ended) continue;
                    try { using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3)); await api.SendAsync<JsonElement>(HttpMethod.Post, $"terminals/{pair.Key}/state", new { instanceId, jobId = pair.Value.LastJob, status = "closed" }, deadline.Token); } catch { }
                    lock (sync)
                        if (!pair.Value.Executing && entries.Remove(pair.Key)) pair.Value.Shell.Dispose();
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally { lock (sync) foreach (var entry in entries.Values) entry.Shell.End(); }
    }
    public void Dispose()
    {
        lock (sync)
        {
            if (disposed) return; disposed = true;
            foreach (var entry in entries.Values) entry.Shell.Dispose(); entries.Clear();
        }
    }
}
