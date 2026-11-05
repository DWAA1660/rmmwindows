using System.Text.Json;
using System.Text.RegularExpressions;

namespace LibraryRmm.Agent;

public sealed record AgentUpdateStatus(int SchemaVersion, string InstalledVersion, string? AvailableVersion,
    string Phase, string Stage, DateTimeOffset CheckedAt, DateTimeOffset? LastAttemptAt, DateTimeOffset? NextRetryAt,
    int Attempts, string? ErrorCode, string Summary, string? PackageSha256);

/// <summary>Bounded, structured update evidence. Never reports exception text, paths, URLs or credentials.</summary>
internal static class UpdateDiagnostics
{
    private static readonly HashSet<string> Phases = ["checking", "current", "disabled", "deferred", "downloading", "verifying", "installing", "failed", "retry_wait", "unsupported"];
    private static readonly HashSet<string> Stages = ["manifest", "download", "verify", "extract", "launch", "install", "complete", "policy"];
    internal static readonly IReadOnlyDictionary<string, string> ErrorSummaries = new Dictionary<string, string>
    {
        ["disabled"]="Automatic updates are disabled.", ["unsupported_install"]="Automatic update requires a supported service installation.",
        ["deferred_busy"]="Update check deferred while endpoint work is active.", ["dns_error"]="Update server name could not be resolved.",
        ["tls_error"]="Update connection failed TLS validation.", ["network_error"]="Update server could not be reached.",
        ["request_timeout"]="Update request timed out.", ["http_error"]="Update server returned an unsuccessful response.",
        ["manifest_invalid"]="Update package metadata was invalid.", ["checksum_mismatch"]="Downloaded package integrity verification failed.",
        ["extract_failed"]="Verified update package could not be extracted.", ["launch_failed"]="Update helper could not be started.",
        ["install_failed"]="Update installation failed.", ["pipeline_stopped"]="Update installer PowerShell pipeline stopped unexpectedly.",
        ["helper_stalled"]="Update helper did not finish within the expected time.", ["attempt_limit"]="Automatic update attempt limit reached for this package.",
        ["retry_backoff"]="Update retry is waiting for its backoff period.", ["state_invalid"]="Previous update state could not be read safely.",
        ["cancelled"]="Update operation was cancelled.", ["unknown_failure"]="Update operation failed."
    };
    private static readonly IReadOnlyDictionary<string, string> PhaseSummaries = new Dictionary<string, string>
    {
        ["checking"]="Checking for an agent update.", ["current"]="Installed agent is up to date.", ["disabled"]="Automatic updates are disabled.",
        ["deferred"]="Update check is deferred.", ["downloading"]="Downloading the agent update.", ["verifying"]="Verifying the agent update.",
        ["installing"]="Installing the verified agent update.", ["failed"]="Update operation failed.", ["retry_wait"]="Waiting before retrying the agent update.",
        ["unsupported"]="Automatic update is unavailable for this installation."
    };
    private static readonly Regex VersionPattern = new(@"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:[-+][A-Za-z0-9.-]{1,80})?$", RegexOptions.CultureInvariant);
    internal static bool ValidVersion(string? value) => value is not null && VersionPattern.IsMatch(value);
    private static string? SafeHash(string? value) => value is not null && Regex.IsMatch(value, "^[a-f0-9]{64}$") ? value : null;
    internal static string SafeSummary(string phase, string? code) => code is not null && ErrorSummaries.TryGetValue(code, out var text)
        ? text : PhaseSummaries.GetValueOrDefault(phase, PhaseSummaries["failed"]);
    private static string Root(AgentConfiguration config) => Path.Combine(config.DataDirectory, "updates");

    internal static AgentUpdateStatus PublishReport(AgentConfiguration config, string phase, string stage, string? errorCode = null,
        string? availableVersion = null, string? packageSha256 = null, UpdateAttemptState? attemptState = null,
        DateTimeOffset? nextRetryAt = null, DateTimeOffset? now = null)
    {
        phase = Phases.Contains(phase) ? phase : "failed"; stage = Stages.Contains(stage) ? stage : "policy";
        errorCode = errorCode is null ? null : ErrorSummaries.ContainsKey(errorCode) ? errorCode : "unknown_failure";
        var report = new AgentUpdateStatus(1, AgentVersion.Value, ValidVersion(availableVersion) ? availableVersion : null,
            phase, stage, now ?? DateTimeOffset.UtcNow, attemptState?.LastAttemptUtc, nextRetryAt,
            Math.Clamp(attemptState?.Attempts ?? 0, 0, AgentUpdater.MaxAttemptsPerPackage), errorCode, SafeSummary(phase, errorCode), SafeHash(packageSha256));
        Write(config, report);
        return report;
    }

    internal static AgentUpdateStatus Load(AgentConfiguration config)
    {
        var now = DateTimeOffset.UtcNow;
        try
        {
            var stored = Read<AgentUpdateStatus>(config, "update-status.json");
            var state = Read<UpdateAttemptState>(config, "update-state.json");
            var phase = stored is not null && Phases.Contains(stored.Phase) ? stored.Phase : "checking";
            var stage = stored is not null && Stages.Contains(stored.Stage) ? stored.Stage : "policy";
            var available = ValidVersion(stored?.AvailableVersion) ? stored!.AvailableVersion : ValidVersion(state?.Version) ? state!.Version : null;
            var digest = SafeHash(stored?.PackageSha256) ?? SafeHash(state?.Sha256);
            var code = stored?.ErrorCode is { } candidate && ErrorSummaries.ContainsKey(candidate) ? candidate : null;
            var lastAttempt = state?.LastAttemptUtc ?? stored?.LastAttemptAt;
            var attempts = Math.Clamp(state?.Attempts ?? stored?.Attempts ?? 0, 0, AgentUpdater.MaxAttemptsPerPackage);
            var checkedAt = stored?.CheckedAt ?? now;
            if(stored is null && state is not null && available is not null && AgentUpdater.IsNewer(available,AgentVersion.Value)) { phase="installing";stage="install"; }
            if (!config.AutoUpdate) { phase="disabled";stage="policy";code="disabled"; }
            else if (available is not null && !AgentUpdater.IsNewer(available, AgentVersion.Value)) { phase="current";stage="complete";code=null; }
            else
            {
                var result = new[] { Read<UpdateHelperResult>(config,"update-result.json"), Read<UpdateHelperResult>(config,"installer-result.json") }
                    .Where(value=>value is not null && value.SchemaVersion==1 && value.Version==available && value.CompletedAt >= (lastAttempt ?? DateTimeOffset.MinValue))
                    .OrderByDescending(value=>value!.CompletedAt).FirstOrDefault();
                if (result is not null && !result.Success)
                {
                    phase="failed";stage="install";code=ErrorSummaries.ContainsKey(result.ErrorCode ?? "") ? result.ErrorCode : "install_failed";
                    checkedAt=result.CompletedAt;
                }
                else if (phase is "installing" or "retry_wait" && available is not null && HasPipelineStopped(config,available,lastAttempt))
                { phase="failed";stage="install";code="pipeline_stopped"; }
                else if (phase=="installing" && lastAttempt.HasValue && now-lastAttempt.Value>TimeSpan.FromMinutes(10))
                {
                    phase="failed";stage="install";code="helper_stalled";
                    // Existing agents only wrote a transcript. Inspect a bounded tail for one fixed
                    // known failure marker; never include any transcript content in telemetry.
                    if (available is not null && HasPipelineStopped(config,available,lastAttempt)) code="pipeline_stopped";
                }
            }
            DateTimeOffset? retry = attempts>0 && attempts<AgentUpdater.MaxAttemptsPerPackage && lastAttempt.HasValue
                ? lastAttempt.Value.AddMinutes(30*Math.Pow(4,attempts-1)) : null;
            if (phase=="failed" && retry>now) phase="retry_wait";
            if (phase=="failed" && attempts>=AgentUpdater.MaxAttemptsPerPackage && code is null) code="attempt_limit";
            var report=new AgentUpdateStatus(1,AgentVersion.Value,available,phase,stage,checkedAt,lastAttempt,retry,attempts,code,SafeSummary(phase,code),digest);
            // Persist reconciled helper outcomes so a restart cannot hide a prior failed handoff.
            if (report != stored) Write(config,report);
            return report;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return new(1,AgentVersion.Value,null,"failed","policy",now,null,null,0,"state_invalid",SafeSummary("failed","state_invalid"),null);
        }
    }

    internal static void Write(AgentConfiguration config, AgentUpdateStatus report)
    {
        var directory=Root(config); Directory.CreateDirectory(directory); CheckPath(config,directory);
        var target=Path.Combine(directory,"update-status.json"); CheckPath(config,target);
        var temporary=target+"."+Guid.NewGuid().ToString("N")+".tmp";
        try { File.WriteAllText(temporary,JsonSerializer.Serialize(report,AgentConfiguration.Json));File.Move(temporary,target,true); }
        finally { if(File.Exists(temporary)) File.Delete(temporary); }
    }
    private static T? Read<T>(AgentConfiguration config,string name)
    {
        var path=Path.Combine(Root(config),name); CheckPath(config,path);
        if(!File.Exists(path)) return default;
        if(new FileInfo(path).Length>65536) throw new InvalidDataException("Update state exceeds bounds.");
        return JsonSerializer.Deserialize<T>(File.ReadAllText(path),AgentConfiguration.Json);
    }
    private static void CheckPath(AgentConfiguration config,string path)
    {
        var root=Path.GetFullPath(config.DataDirectory).TrimEnd(Path.DirectorySeparatorChar);
        var full=Path.GetFullPath(path);
        if(!full.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new IOException("Unsafe update diagnostics path.");
        for(var current=full;current.Length>=root.Length;current=Path.GetDirectoryName(current) ?? "")
        {
            if((File.Exists(current)||Directory.Exists(current)) && File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Unsafe update diagnostics path.");
            if(current.Equals(root,StringComparison.OrdinalIgnoreCase)) break;
        }
    }
    private static bool HasPipelineStopped(AgentConfiguration config,string version,DateTimeOffset? since)
    {
        var path=Path.Combine(Root(config),$"update-{version}.log");CheckPath(config,path);
        if(!File.Exists(path)) return false;
        if(since.HasValue && File.GetLastWriteTimeUtc(path)<since.Value.UtcDateTime.AddSeconds(-1)) return false;
        using var stream=File.OpenRead(path);stream.Position=Math.Max(0,stream.Length-32768);
        using var reader=new StreamReader(stream);
        return reader.ReadToEnd().Contains("pipeline has been stopped",StringComparison.OrdinalIgnoreCase);
    }
    private sealed record UpdateHelperResult(int SchemaVersion,string Version,bool Success,string? ErrorCode,DateTimeOffset CompletedAt);
}
