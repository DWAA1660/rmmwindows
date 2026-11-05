using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace LibraryRmm.Agent;

// AutoUpdate comes only from the authenticated per-endpoint manifest (server group setting);
// it is null from the anonymous public manifest, which means "allowed".
public sealed record AgentPackageManifest(string Version, string Runtime, string Sha256, long SizeBytes, string DownloadUrl, bool? AutoUpdate = null);
internal sealed record UpdateAttemptState(string Version, string Sha256, int Attempts, DateTimeOffset LastAttemptUtc);
internal sealed record StagedUpdate(string Version, string Directory);

/// <summary>
/// Startup self-update. Runs once when the Windows service starts, BEFORE any job is claimed,
/// so an update never interrupts a command. Safety rules:
/// * Only the enrolled server origin is contacted; redirects are refused; TLS validation stays on.
/// * Only a strictly newer, plain x.y.z version for win-x64 is accepted (no downgrade/equal loop).
/// * The attempt is persisted BEFORE download/handover: at most <see cref="MaxAttemptsPerPackage"/>
///   attempts per package digest, with backoff, so a bad package cannot cause a restart loop.
///   (On restore-on-reboot machines the state is rolled back with the disk; that yields at most
///   one update per boot, never a loop within a boot.)
/// * The archive SHA-256 is verified before extraction; extraction refuses path traversal;
///   the inner package manifest version and agent executable hash are verified before handover.
/// * A detached helper runs the package's own Install-Agent.ps1, which preserves enrollment,
///   stops/starts only the LibraryRmmAgent service and never reboots. If it fails, the helper
///   starts the existing service again. Any failure here leaves the installed agent running.
/// </summary>
internal sealed class AgentUpdater : IDisposable
{
    internal const string DownloadPath = "/downloads/library-rmm-agent-win-x64.zip";
    internal const string ServiceName = "LibraryRmmAgent";
    internal const int MaxAttemptsPerPackage = 3;
    private const long MaxPackageBytes = 256L * 1024 * 1024;
    private const long MaxExtractedBytes = 1024L * 1024 * 1024;
    private static readonly Regex PlainVersion = new(@"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Hex = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private readonly AgentConfiguration configuration;
    private readonly HttpClient client;
    private readonly ILogger logger;
    private readonly Func<DateTimeOffset> clock;
    private string activeStage = "manifest";
    private AgentPackageManifest? activeManifest;
    private UpdateAttemptState? activeState;

    public AgentUpdater(AgentConfiguration configuration, ILogger logger, HttpMessageHandler? handler = null, Func<DateTimeOffset>? clock = null)
    {
        this.configuration = configuration;
        this.logger = logger;
        this.clock = clock ?? (() => DateTimeOffset.UtcNow);
        client = new HttpClient(handler ?? new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
        {
            BaseAddress = new Uri(configuration.ServerUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromMinutes(10)
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("LibraryRmm-Agent/" + AgentVersion.Value);
    }

    public string UpdatesDirectory => Path.Combine(configuration.DataDirectory, "updates");
    private string StatePath => Path.Combine(UpdatesDirectory, "update-state.json");

    /// <summary>Returns true only if a helper was launched that will stop and replace this service.</summary>
    public static async Task<bool> TryBeginUpdateAsync(AgentConfiguration configuration, ILogger logger, CancellationToken ct)
    {
        if (!configuration.AutoUpdate)
        {
            ReportSafely(configuration,"disabled","policy","disabled");
            logger.LogInformation("Automatic agent updates are disabled in agent.json.");
            return false;
        }
        try
        {
            var installDirectory = InstalledDirectory();
            if (installDirectory is null)
            {
                ReportSafely(configuration,"unsupported","policy","unsupported_install");
                logger.LogInformation("Agent is not running from a LibraryRmm install directory; startup update skipped.");
                return false;
            }
            using var updater = new AgentUpdater(configuration, logger);
            var staged = await updater.PrepareAsync(AgentVersion.Value, ct);
            if (staged is null) return false;
            try { updater.Report("installing","launch"); updater.Launch(staged, installDirectory); }
            catch { updater.Report("failed","launch","launch_failed"); throw; }
            logger.LogInformation("Verified agent {Version} staged; update helper launched. No jobs will be claimed until restart.", staged.Version);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception exception)
        {
            logger.LogWarning("Startup update check failed ({FailureType}); continuing with installed agent {Version}.",
                exception.GetType().Name, AgentVersion.Value);
            return false;
        }
    }

    internal static string? InstalledDirectory()
    {
        var path = Environment.ProcessPath;
        if (string.IsNullOrEmpty(path) || !Path.GetFileName(path).Equals("LibraryRmm.Agent.exe", StringComparison.OrdinalIgnoreCase)) return null;
        var directory = Path.GetDirectoryName(path);
        return directory is not null && Path.GetFileName(directory).Equals("LibraryRmm", StringComparison.OrdinalIgnoreCase) ? directory : null;
    }

    internal async Task<StagedUpdate?> PrepareAsync(string currentVersion, CancellationToken ct)
    {
        try
        {
        activeStage="manifest"; Report("checking","manifest");
        // At boot the service can start before DHCP/DNS/proxy/TLS connectivity is ready.
        // Retry only metadata reads, before recording an install attempt or claiming jobs.
        var manifest = await FetchManifestWithRetryAsync(() => FetchManifestAsync(ct), logger, ct);
        activeManifest=manifest;
        if (manifest.AutoUpdate == false)
        {
            // An operator turned automatic updates off for this computer's group (for example
            // restore-protected computers). Manual updates from the console still work.
            Report("disabled","policy","group_disabled");
            logger.LogInformation("Automatic agent updates are turned off for this computer's group.");
            return null;
        }
        if (!IsNewer(manifest.Version, currentVersion)) { Report("current","complete"); return null; }
        EnsureSafeDirectory(UpdatesDirectory);
        activeStage="policy";
        var state = ReadState();
        activeState=state;
        if (!MayAttempt(state, manifest, clock()))
        {
            Report("retry_wait","policy",state?.Attempts>=MaxAttemptsPerPackage?"attempt_limit":"retry_backoff",
                state is not null && state.Attempts<MaxAttemptsPerPackage ? state.LastAttemptUtc.AddMinutes(30*Math.Pow(4,Math.Max(0,state.Attempts-1))) : null);
            logger.LogInformation("Agent {Version} is available but update attempts are paused after {Attempts} attempt(s).",
                manifest.Version, state?.Attempts ?? 0);
            return null;
        }
        var samePackage = state is not null && state.Version == manifest.Version && state.Sha256 == manifest.Sha256;
        // Persist the attempt FIRST so a crash, bad package or failed install cannot loop.
        activeState=new UpdateAttemptState(manifest.Version, manifest.Sha256, samePackage ? state!.Attempts + 1 : 1, clock());
        WriteState(activeState);
        RemoveStaleStaging(keep: null);
        var archive = Path.Combine(UpdatesDirectory, manifest.Sha256 + ".zip");
        var destination = Path.Combine(UpdatesDirectory, $"{manifest.Version}-{manifest.Sha256[..12]}");
        try
        {
            activeStage="download";Report("downloading","download");
            await DownloadAsync(manifest, archive, ct);
            activeStage="extract";Report("verifying","extract");
            ExtractVerified(archive, destination, manifest.Version);
        }
        catch
        {
            TryDeleteDirectory(destination);
            throw;
        }
        finally { TryDeleteFile(archive); TryDeleteFile(archive + ".partial"); }
        return new StagedUpdate(manifest.Version, destination);
        }
        catch(Exception exception)
        {
            Report("failed",activeStage,ct.IsCancellationRequested?"cancelled":ErrorCode(exception,activeStage));
            throw;
        }
    }

    private void Report(string phase,string stage,string? code=null,DateTimeOffset? retry=null) =>
        ReportSafely(configuration,phase,stage,code,activeManifest?.Version,activeManifest?.Sha256,activeState,retry,clock());

    private static void ReportSafely(AgentConfiguration config,string phase,string stage,string? code=null,string? version=null,
        string? digest=null,UpdateAttemptState? state=null,DateTimeOffset? retry=null,DateTimeOffset? now=null)
    {
        try { UpdateDiagnostics.PublishReport(config,phase,stage,code,version,digest,state,retry,now); }
        catch(Exception exception) when(exception is IOException or UnauthorizedAccessException) { /* Never stop installed agent solely for diagnostics I/O. */ }
    }

    internal static string ErrorCode(Exception exception,string stage)
    {
        if(exception is OperationCanceledException) return "request_timeout";
        if(exception is HttpRequestException http) return http.HttpRequestError switch {
            HttpRequestError.NameResolutionError=>"dns_error",HttpRequestError.SecureConnectionError=>"tls_error",_=>"network_error" };
        if(exception is AgentApiException) return "http_error";
        if(stage=="policy") return "state_invalid";
        if(stage=="manifest" && exception is InvalidDataException or JsonException) return "manifest_invalid";
        if(stage=="download" && exception is InvalidDataException) return "checksum_mismatch";
        if(stage=="verify") return "checksum_mismatch";
        if(stage=="extract") return "extract_failed";
        if(stage=="launch") return "launch_failed";
        return "unknown_failure";
    }

    internal async Task<AgentPackageManifest> FetchManifestAsync(CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        if (!string.IsNullOrEmpty(configuration.AgentToken))
        {
            // Per-endpoint manifest carries the group's automatic-update setting. The bearer
            // credential only ever goes to the configured server (redirects are disabled).
            using var request = new HttpRequestMessage(HttpMethod.Get, "api/agent/update-manifest");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", configuration.AgentToken);
            using var authenticated = await client.SendAsync(request, deadline.Token);
            if (authenticated.StatusCode == HttpStatusCode.OK)
            {
                var scoped = await authenticated.Content.ReadFromJsonAsync<AgentPackageManifest>(AgentConfiguration.Json, deadline.Token)
                    ?? throw new InvalidDataException("Empty agent package manifest.");
                ValidateManifest(scoped);
                return scoped;
            }
            // Only an older server without the route falls back to the anonymous manifest.
            if (authenticated.StatusCode != HttpStatusCode.NotFound) throw new AgentApiException((int)authenticated.StatusCode);
        }
        using var response = await client.GetAsync("api/agent-download", deadline.Token);
        if (response.StatusCode != HttpStatusCode.OK) throw new AgentApiException((int)response.StatusCode);
        var manifest = await response.Content.ReadFromJsonAsync<AgentPackageManifest>(AgentConfiguration.Json, deadline.Token)
            ?? throw new InvalidDataException("Empty agent package manifest.");
        ValidateManifest(manifest);
        return manifest;
    }

    internal static async Task<AgentPackageManifest> FetchManifestWithRetryAsync(
        Func<Task<AgentPackageManifest>> fetch, ILogger logger, CancellationToken ct,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        delay ??= Task.Delay;
        int[] delays = [5, 15, 30];
        for (var attempt = 0; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try { return await fetch(); }
            catch (Exception exception) when (!ct.IsCancellationRequested && attempt < delays.Length &&
                (exception is HttpRequestException or OperationCanceledException ||
                 exception is AgentApiException api && (api.StatusCode is 408 or 429 || api.StatusCode >= 500)))
            {
                logger.LogWarning("Startup update manifest attempt {Attempt} failed ({FailureType}); retrying in {Seconds}s before accepting jobs.",
                    attempt + 1, exception.GetType().Name, delays[attempt]);
                await delay(TimeSpan.FromSeconds(delays[attempt]), ct);
            }
        }
    }

    internal static void ValidateManifest(AgentPackageManifest manifest)
    {
        if (manifest.Runtime != "win-x64") throw new InvalidDataException("Agent package runtime is not win-x64.");
        if (manifest.DownloadUrl != DownloadPath) throw new InvalidDataException("Agent package URL is not the fixed same-origin download path.");
        if (!UpdateDiagnostics.ValidVersion(manifest.Version)) throw new InvalidDataException("Agent package version is invalid.");
        if (manifest.Sha256 is null || !Sha256Hex.IsMatch(manifest.Sha256)) throw new InvalidDataException("Agent package digest is invalid.");
        if (manifest.SizeBytes is <= 0 or > MaxPackageBytes) throw new InvalidDataException("Agent package size is outside supported bounds.");
    }

    /// <summary>Only plain x.y.z releases are installed automatically; prereleases are skipped.</summary>
    internal static bool IsNewer(string candidate, string current)
    {
        if (!PlainVersion.IsMatch(candidate)) return false;
        var currentCore = current.Split('-', '+')[0];
        if (!Version.TryParse(candidate, out var next) || !Version.TryParse(currentCore, out var installed)) return false;
        return next > installed;
    }

    internal static bool MayAttempt(UpdateAttemptState? state, AgentPackageManifest manifest, DateTimeOffset now)
    {
        if (state is null || state.Version != manifest.Version || state.Sha256 != manifest.Sha256) return true;
        if (state.Attempts >= MaxAttemptsPerPackage) return false;
        var backoff = TimeSpan.FromMinutes(30 * Math.Pow(4, Math.Max(0, state.Attempts - 1)));
        return now - state.LastAttemptUtc >= backoff;
    }

    private async Task DownloadAsync(AgentPackageManifest manifest, string archive, CancellationToken ct)
    {
        // ResponseHeadersRead ends HttpClient.Timeout protection at the headers. Bound the
        // entire body transfer too, so a stalled server cannot block job pickup indefinitely.
        using var transferDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        transferDeadline.CancelAfter(TimeSpan.FromMinutes(10));
        ct = transferDeadline.Token;
        using var response = await client.GetAsync(DownloadPath.TrimStart('/'), HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode != HttpStatusCode.OK) throw new AgentApiException((int)response.StatusCode);
        var partial = archive + ".partial";
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long total = 0;
        await using (var source = await response.Content.ReadAsStreamAsync(ct))
        await using (var target = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            var buffer = new byte[81920];
            int read;
            while ((read = await source.ReadAsync(buffer, ct)) > 0)
            {
                total += read;
                if (total > manifest.SizeBytes || total > MaxPackageBytes) throw new InvalidDataException("Agent package is larger than its manifest.");
                hash.AppendData(buffer, 0, read);
                await target.WriteAsync(buffer.AsMemory(0, read), ct);
            }
        }
        var actual = Convert.ToHexStringLower(hash.GetHashAndReset());
        activeStage="verify";Report("verifying","verify");
        if (total != manifest.SizeBytes || actual != manifest.Sha256) throw new InvalidDataException("Agent package SHA-256 or size does not match the manifest.");
        File.Move(partial, archive, overwrite: true);
    }

    internal static void ExtractVerified(string archive, string destination, string expectedVersion)
    {
        TryDeleteDirectory(destination);
        var root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(root);
        long extracted = 0;
        using (var zip = ZipFile.OpenRead(archive))
        {
            foreach (var entry in zip.Entries)
            {
                var name = entry.FullName.Replace('\\', '/');
                if (name.Length == 0 || name.Contains(':') || name.StartsWith('/') || name.Split('/').Contains(".."))
                    throw new InvalidDataException("Agent package contains an unsafe path.");
                var target = Path.GetFullPath(Path.Combine(root, name));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Agent package contains an unsafe path.");
                if (name.EndsWith('/')) { Directory.CreateDirectory(target); continue; }
                extracted += entry.Length;
                if (extracted > MaxExtractedBytes) throw new InvalidDataException("Agent package expands beyond supported bounds.");
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: false);
            }
        }
        var manifestPath = Path.Combine(root, "package-manifest.json");
        var installer = Path.Combine(root, "Install-Agent.ps1");
        var executable = Path.Combine(root, "agent", "LibraryRmm.Agent.exe");
        if (!File.Exists(manifestPath) || !File.Exists(installer) || !File.Exists(executable))
            throw new InvalidDataException("Agent package is missing its manifest, installer or executable.");
        using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var inner = document.RootElement;
        if (!inner.TryGetProperty("version", out var version) || version.GetString() != expectedVersion ||
            !inner.TryGetProperty("runtime", out var runtime) || runtime.GetString() != "win-x64" ||
            !inner.TryGetProperty("agentSha256", out var agentHash) || agentHash.GetString() is not { } expectedAgentHash)
            throw new InvalidDataException("Inner package manifest does not match the advertised version.");
        using var stream = File.OpenRead(executable);
        if (Convert.ToHexStringLower(SHA256.HashData(stream)) != expectedAgentHash.ToLowerInvariant())
            throw new InvalidDataException("Agent executable hash does not match the package manifest.");
        // Older releases have no companion field. When advertised, validate it before handing
        // the verified installer to the update helper; the archive hash already covers all files.
        if (inner.TryGetProperty("companionSha256", out var supportHash))
        {
            var supportExe = Path.Combine(root, "agent", "companion", "LibraryRmm.Support.exe");
            if (!File.Exists(supportExe) || supportHash.GetString() is not { } expectedSupportHash)
                throw new InvalidDataException("Support companion is missing from this package.");
            using var supportStream = File.OpenRead(supportExe);
            if (Convert.ToHexStringLower(SHA256.HashData(supportStream)) != expectedSupportHash.ToLowerInvariant())
                throw new InvalidDataException("Support companion hash does not match the package manifest.");
        }
    }

    internal static string BuildHelperScript(StagedUpdate staged, string installDirectory, AgentConfiguration configuration)
    {
        static string Quote(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        var updatesDirectory=Path.Combine(configuration.DataDirectory,"updates");
        var origin = new Uri(configuration.ServerUrl).GetLeftPart(UriPartial.Authority);
        var log = Path.Combine(updatesDirectory, $"update-{staged.Version}.log");
        var insecure = configuration.AllowInsecureLocalhost ? " -AllowInsecureLocalhost" : "";
        return $$"""
            # Generated by the Library RMM agent. Applies a verified package, then exits.
            $ErrorActionPreference = 'Stop'
            $resultPath = {{Quote(Path.Combine(updatesDirectory,"update-result.json"))}}
            $code = 1
            $resultError = 'install_failed'
            $transcriptStarted = $false
            try {
                Start-Transcript -LiteralPath {{Quote(log)}} -Append | Out-Null
                $transcriptStarted = $true
                & {{Quote(Path.Combine(staged.Directory, "Install-Agent.ps1"))}} -ServerUrl {{Quote(origin)}} -InstallDirectory {{Quote(installDirectory)}} -DataDirectory {{Quote(configuration.DataDirectory)}}{{insecure}}
                Write-Host 'Agent update to {{staged.Version}} completed.'
                $code = 0
                $resultError = $null
            } catch {
                if ($_.Exception -is [System.Management.Automation.PipelineStoppedException] -or $_.Exception.InnerException -is [System.Management.Automation.PipelineStoppedException]) { $resultError = 'pipeline_stopped' }
                Write-Host ('Agent update failed: ' + $resultError)
                try {
                    $service = Get-Service -Name '{{ServiceName}}' -ErrorAction SilentlyContinue
                    if ($service -and $service.Status -ne 'Running') { Start-Service -Name '{{ServiceName}}' -ErrorAction SilentlyContinue }
                } catch { }
                $code = 1
            } finally {
                # Fixed structured result survives ordinary failures without exposing transcript text.
                try {
                    $result = @{ schemaVersion=1; version='{{staged.Version}}'; success=($code -eq 0); errorCode=$resultError; stage=$(if($code -eq 0){'complete'}else{'install'}); completedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
                    $temporary = $resultPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
                    [IO.File]::WriteAllText($temporary,$result,(New-Object Text.UTF8Encoding($false)))
                    if([IO.File]::Exists($resultPath)) { [IO.File]::Replace($temporary,$resultPath,$null) } else { [IO.File]::Move($temporary,$resultPath) }
                } catch { }
                if($transcriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
            }
            exit $code
            """;
    }

    private void Launch(StagedUpdate staged,string installDirectory)
    {
        var helper=Path.Combine(staged.Directory,"apply-update.ps1");
        File.WriteAllText(helper,BuildHelperScript(staged,installDirectory,configuration),new UTF8Encoding(encoderShouldEmitUTF8Identifier:true));
        var start = new ProcessStartInfo(PowerShellRunner.PowerShellPath)
        {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = staged.Directory
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", helper })
            start.ArgumentList.Add(argument);
        // Detached on purpose: the helper must outlive this service process while it is replaced.
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Update helper did not start.");
    }

    internal UpdateAttemptState? ReadState()
    {
        if(!File.Exists(StatePath)) return null;
        if(new FileInfo(StatePath).Length>65536 || File.GetAttributes(StatePath).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Unsafe update attempt state.");
        var state=JsonSerializer.Deserialize<UpdateAttemptState>(File.ReadAllText(StatePath),AgentConfiguration.Json);
        if(state is null || !UpdateDiagnostics.ValidVersion(state.Version) || state.Sha256 is null || !Sha256Hex.IsMatch(state.Sha256) || state.Attempts is <1 or >MaxAttemptsPerPackage)
            throw new InvalidDataException("Invalid update attempt state.");
        return state;
    }

    private void WriteState(UpdateAttemptState state)
    {
        var temporary = StatePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(state, AgentConfiguration.Json));
        File.Move(temporary, StatePath, overwrite: true);
    }

    private void RemoveStaleStaging(string? keep)
    {
        foreach (var directory in Directory.GetDirectories(UpdatesDirectory))
            if (keep is null || !Path.GetFullPath(directory).Equals(Path.GetFullPath(keep), StringComparison.OrdinalIgnoreCase))
                TryDeleteDirectory(directory);
    }

    private void EnsureSafeDirectory(string path)
    {
        Directory.CreateDirectory(path);
        var stop = Path.GetFullPath(configuration.DataDirectory).TrimEnd(Path.DirectorySeparatorChar);
        for (var current = new DirectoryInfo(Path.GetFullPath(path)); current is not null; current = current.Parent)
        {
            if (current.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Update staging path traverses a reparse point.");
            if (current.FullName.TrimEnd(Path.DirectorySeparatorChar).Equals(stop, StringComparison.OrdinalIgnoreCase)) break;
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            var info = new DirectoryInfo(path);
            if (!info.Exists) return;
            // Never follow a junction out of the staging directory while deleting.
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) { info.Delete(); return; }
            info.Delete(recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteFile(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public void Dispose() => client.Dispose();
}
