using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;

namespace LibraryRmm.Agent;

public sealed class AgentWorker(AgentConfiguration configuration, AgentApi api, OutputSpool spool,
    PowerShellRunner runner, InventoryCollector inventory, ILogger<AgentWorker> logger) : BackgroundService
{
    internal const int ClaimWaitSeconds = 20;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Startup self-update happens BEFORE recovery, heartbeats or job claims, so it can never
        // interrupt a command. Console/test runs are never updated.
        if (WindowsServiceHelpers.IsWindowsService() &&
            await AgentUpdater.TryBeginUpdateAsync(configuration, logger, stoppingToken))
        {
            try { await Task.Delay(TimeSpan.FromMinutes(10), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            logger.LogWarning("Update helper did not restart the service within 10 minutes; continuing with installed agent {Version}.", AgentVersion.Value);
        }
        // Tokenless installs wait here until an operator approves them in the console.
        if (configuration.AwaitingApproval)
        {
            try { await AgentJoin.WaitForApprovalAsync(configuration, logger, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        }
        await spool.RecoverInterruptedAsync();
        var heartbeat = HeartbeatLoopAsync(stoppingToken);
        var uploads = UploadLoopAsync(stoppingToken);
        logger.LogInformation("Library RMM agent started. Endpoint {EndpointId}; outbound management only.", configuration.EndpointId);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var pause = false;
                try
                {
                    // Long-poll: the server answers as soon as a job is queued (or after ~20 s), so an
                    // operator's action starts within moments. 20 s stays well below the 30 s client timeout.
                    var started = DateTimeOffset.UtcNow;
                    var job = await api.ClaimAsync(stoppingToken, ClaimWaitSeconds);
                    if (job is not null) await ProcessJobAsync(job, stoppingToken);
                    // A server without long-poll support answers an empty claim at once; never spin on it.
                    else pause = DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(1);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception exception)
                {
                    // Exception messages can include local paths but never payloads or auth headers.
                    logger.LogWarning("Job polling failed ({FailureType}); retrying polling, never execution.", exception.GetType().Name);
                    pause = true;
                }
                if (pause) await Task.Delay(TimeSpan.FromSeconds(configuration.PollSeconds), stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            try { await Task.WhenAll(heartbeat, uploads); } catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        var nextInventory = DateTimeOffset.MinValue;
        var bootId = "unknown";
        // The server sets the inventory interval for every agent (checkin response
        // "inventoryMinutes") so the console stays current without editing each agent.json.
        var inventoryMinutes = configuration.InventoryMinutes;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                JsonElement? snapshot = null;
                if (DateTimeOffset.UtcNow >= nextInventory)
                {
                    try
                    {
                        snapshot = await inventory.CollectAsync(force: true, ct);
                        bootId = InventoryCollector.BootId(snapshot.Value);
                        nextInventory = DateTimeOffset.UtcNow.AddMinutes(inventoryMinutes);
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                    catch (Exception exception)
                    {
                        // An inventory failure must never stop heartbeats (the endpoint would look offline).
                        logger.LogWarning("Inventory collection failed ({FailureType}); heartbeat continues, inventory retried in 5 minutes.", exception.GetType().Name);
                        nextInventory = DateTimeOffset.UtcNow.AddMinutes(Math.Min(5, inventoryMinutes));
                    }
                }
                var response = snapshot.HasValue
                    ? await api.CheckInAsync(new { bootId, inventory = snapshot.Value }, ct)
                    : await api.CheckInAsync(new { bootId }, ct);
                if (response.ValueKind == JsonValueKind.Object && response.TryGetProperty("inventoryMinutes", out var minutes) &&
                    minutes.TryGetInt32(out var serverMinutes) && serverMinutes is >= 1 and <= 1440 && serverMinutes != inventoryMinutes)
                {
                    // A shorter interval applies immediately; a longer one after the next collection.
                    var sooner = DateTimeOffset.UtcNow.AddMinutes(serverMinutes);
                    if (serverMinutes < inventoryMinutes && sooner < nextInventory) nextInventory = sooner;
                    inventoryMinutes = serverMinutes;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception exception) { logger.LogWarning("Heartbeat failed ({FailureType}); enrollment identity retained.", exception.GetType().Name); }
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
        }
    }

    private async Task UploadLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await spool.FlushAsync(api, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception exception) { logger.LogWarning("Output delivery deferred ({FailureType}); local journal retained.", exception.GetType().Name); }
            // Short interval so command output reaches the console within about a second.
            await Task.Delay(TimeSpan.FromMilliseconds(500), ct);
        }
    }

    private async Task ProcessJobAsync(AgentJob job, CancellationToken ct)
    {
        var journal = await spool.CreateAsync(job);
        try
        {
            // This network call is intentionally NOT retried. If the response is lost, the
            // server may have consumed the authorization. Uncertainty must never cause replay.
            var authorized = await ExecutionGate.StartOnceAsync(() => api.StartAsync(job, ct));
            if (!authorized)
            {
                await journal.CompleteAsync(new JobCompletion("interrupted", null,
                    "Server did not grant a fresh execution authorization; no command was executed."));
                return;
            }
            ct.ThrowIfCancellationRequested();
            var timeout = Math.Clamp(job.TimeoutSeconds, 1, 86400);
            await journal.AppendAsync("system", $"Execution authorized for {job.Kind} at {DateTimeOffset.UtcNow:O}.\n");
            switch (job.Kind)
            {
                case "powershell":
                {
                    var script = RequiredString(job.Payload, "script", 1024 * 1024);
                    var result = await runner.RunScriptAsync(script, journal.DirectoryPath, journal.AppendAsync, timeout, ct);
                    await CompleteProcessAsync(journal, result, "PowerShell command completed.");
                    break;
                }
                case "inventory":
                {
                    var snapshot = await inventory.CollectAsync(force: true, ct);
                    await api.CheckInAsync(new { bootId = InventoryCollector.BootId(snapshot), inventory = snapshot }, ct);
                    await journal.AppendAsync("stdout", snapshot.GetRawText() + "\n");
                    await journal.CompleteAsync(new JobCompletion("succeeded", 0, "Endpoint inventory refreshed."));
                    break;
                }
                case "storage":
                {
                    var path = RequiredString(job.Payload, "path", 4096);
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(Math.Min(timeout, 120)));
                    await StorageExplorer.InspectAsync(path, journal.AppendAsync, deadline.Token);
                    await journal.CompleteAsync(new JobCompletion("succeeded", 0, "Read-only storage report completed; inspect partial/errors fields."));
                    break;
                }
                case "files":
                {
                    // Explorer operations: list/delete/move/copy/rename/mkdir/download. One job = one
                    // operation; per-item results are reported and nothing is ever retried.
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(timeout));
                    var outcome = await FileOperations.ExecuteAsync(job.Payload, FileSafetyPolicy.ForAgent(configuration.DataDirectory),
                        new AgentFileTransfer(api, job.Id), deadline.Token);
                    await journal.AppendAsync("stdout", outcome.Json);
                    await journal.CompleteAsync(new JobCompletion(outcome.Status, outcome.ExitCode, outcome.Summary));
                    break;
                }
                case "remote_support":
                {
                    // Reaches the launcher only after the same durable start authorization as
                    // every command. This job reports launch; the separately scoped live session
                    // ends on staff refusal, expiry, disconnect or service cancellation.
                    var launched = await SupportLauncher.LaunchAsync(configuration, api, job, ct);
                    await journal.AppendAsync("system", "Staff notification launched. Remote support remains visible and can be declined; no job will be replayed.\n");
                    await journal.CompleteAsync(new JobCompletion("succeeded", 0, "Remote support notification launched; inspect the support window for session status."));
                    break;
                }
                case "reboot":
                {
                    var delay = job.Payload.TryGetProperty("delaySeconds", out var delayValue) && delayValue.TryGetInt32(out var seconds) ? seconds : 60;
                    if (delay is < 30 or > 86400) throw new InvalidDataException("Reboot delay must be between 30 and 86400 seconds.");
                    var reason = job.Payload.TryGetProperty("reason", out var reasonValue) && reasonValue.ValueKind == JsonValueKind.String
                        ? reasonValue.GetString() ?? "Library IT scheduled maintenance" : "Library IT scheduled maintenance";
                    if (reason.Length > 400) throw new InvalidDataException("Reboot reason exceeds 400 characters.");
                    var result = await runner.ScheduleRebootAsync(delay, reason, journal.AppendAsync, ct);
                    var summary = $"Windows accepted a reboot scheduled in {delay} seconds. This confirms the request, not a subsequent boot. This job will never be repeated automatically.";
                    await journal.AppendAsync("system", result.ExitCode == 0 && !result.Interrupted ? summary + "\n" : "Windows did not confirm the reboot request. Do not automatically retry.\n");
                    await CompleteProcessAsync(journal, result, summary);
                    break;
                }
                default: throw new InvalidDataException("Unsupported job kind; no action was taken.");
            }
            logger.LogInformation("Execution ended for job {JobId} ({Kind}). Delivery can continue independently.", job.Id, job.Kind);
        }
        catch (OperationCanceledException)
        {
            await journal.CompleteAsync(new JobCompletion("interrupted", null, "Agent stopped or job deadline elapsed; execution will not be retried."));
        }
        catch (Exception exception)
        {
            await journal.AppendAsync("system", $"Job could not complete ({exception.GetType().Name}). Execution will not be retried.\n");
            // A start call failure is ambiguous. Use interrupted rather than claim success/failure
            // for a command whose process may never have been authorized or launched.
            await journal.CompleteAsync(new JobCompletion("interrupted", null,
                $"Execution or authorization ended with {exception.GetType().Name}; inspect partial output and endpoint state before creating a new job."));
        }
    }

    private static Task CompleteProcessAsync(JobJournal journal, ProcessResult result, string summary) =>
        journal.CompleteAsync(new JobCompletion(result.Interrupted ? "interrupted" : result.ExitCode == 0 ? "succeeded" : "failed",
            result.ExitCode, result.InterruptionReason ?? (result.ExitCode == 0 ? summary : $"Process exited with code {result.ExitCode}; no automatic retry.")));

    private static string RequiredString(JsonElement payload, string property, int maxLength)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(value.GetString()) || value.GetString()!.Length > maxLength)
            throw new InvalidDataException($"Invalid {property} payload.");
        return value.GetString()!;
    }
}

/// <summary>Single attempt only. Authorization failure, false, or an empty body never executes.</summary>
internal static class ExecutionGate
{
    public static async Task<bool> StartOnceAsync(Func<Task<StartResponse?>> request) => (await request())?.MayExecute == true;
}
