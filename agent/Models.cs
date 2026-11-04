using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace LibraryRmm.Agent;

public sealed record AgentConfiguration
{
    public required string ServerUrl { get; init; }
    public required string DeviceId { get; init; }
    /// <summary>Empty while a tokenless join request awaits operator approval; set once approved.</summary>
    public string AgentToken { get; set; } = "";
    public string EndpointId { get; set; } = "";
    /// <summary>Device-generated secret proving ownership of this device's join request. Kept after
    /// approval so a restore-on-reboot rollback of agent.json can recover a credential.</summary>
    public string? JoinSecret { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public bool AwaitingApproval => string.IsNullOrEmpty(AgentToken);
    public int PollSeconds { get; init; } = 10;
    public int InventoryMinutes { get; init; } = 15;
    public bool AllowInsecureLocalhost { get; init; }
    /// <summary>Startup self-update from the enrolled server. Set "autoUpdate": false in agent.json to pin a version.</summary>
    public bool AutoUpdate { get; init; } = true;
    [System.Text.Json.Serialization.JsonIgnore]
    public string DataDirectory { get; init; } = DefaultDataDirectory;
    public static string DefaultDataDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LibraryRmm");
    public static JsonSerializerOptions Json { get; } = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    public static AgentConfiguration Load(string[] args)
    {
        var index = Array.IndexOf(args, "--data-dir");
        var directory = index >= 0 && index + 1 < args.Length ? Path.GetFullPath(args[index + 1]) : DefaultDataDirectory;
        var config = JsonSerializer.Deserialize<AgentConfiguration>(File.ReadAllText(Path.Combine(directory, "agent.json")), Json)
            ?? throw new InvalidDataException("Agent configuration is empty. Run the administrator installer.");
        config = config with { DataDirectory = directory };
        config.Validate();
        return config;
    }

    public void Validate()
    {
        if (!Uri.TryCreate(ServerUrl, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/")
            throw new InvalidDataException("ServerUrl must be an HTTPS origin without credentials or a path.");
        if (uri.Scheme != Uri.UriSchemeHttps && !(AllowInsecureLocalhost && uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))
            throw new InvalidDataException("Agent connections require HTTPS. HTTP is allowed only for an explicitly enabled loopback test.");
        var enrolled = Guid.TryParse(EndpointId, out _) && !string.IsNullOrWhiteSpace(AgentToken);
        var awaitingApproval = string.IsNullOrEmpty(AgentToken) && JoinSecret is { Length: >= 32 and <= 200 };
        if (!Guid.TryParse(DeviceId, out _) || !(enrolled || awaitingApproval))
            throw new InvalidDataException("Agent enrollment configuration is invalid.");
        if (PollSeconds is < 5 or > 300 || InventoryMinutes is < 1 or > 1440)
            throw new InvalidDataException("Agent polling configuration is outside its supported bounds.");
    }
}

public sealed record AgentJob(string Id, string Kind, JsonElement Payload, string DispatchToken, int TimeoutSeconds);
public sealed record OutputChunk(long Sequence, string Stream, string Text);
public sealed record JobCompletion(string Status, int? ExitCode, string Summary);
public sealed record StartResponse(bool MayExecute, string? Status);
public sealed record ClaimResponse(AgentJob? Job);
public sealed record ProcessResult(int ExitCode, bool Interrupted, string? InterruptionReason);
public sealed record JournalManifest(string Id, string Kind, DateTimeOffset CreatedAt);

/// <summary>Separate bearer-only client. Operator cookies are never accepted or stored here.</summary>
public sealed class AgentApi : IDisposable
{
    private readonly HttpClient client;
    private readonly AgentConfiguration configuration;
    public AgentApi(AgentConfiguration configuration) : this(configuration, new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false }) { }
    internal AgentApi(AgentConfiguration configuration, HttpMessageHandler handler)
    {
        this.configuration = configuration;
        client = new HttpClient(handler) { BaseAddress = new Uri(configuration.ServerUrl.TrimEnd('/') + "/api/agent/"), Timeout = TimeSpan.FromSeconds(30) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("LibraryRmm-Agent/" + AgentVersion.Value);
    }

    public async Task<T?> SendAsync<T>(HttpMethod method, string path, object body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body, options: AgentConfiguration.Json) };
        using var response = await SendAuthorizedAsync(request, cancellationToken);
        return await response.Content.ReadFromJsonAsync<T>(AgentConfiguration.Json, cancellationToken);
    }
    private async Task<HttpResponseMessage> SendAuthorizedAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // Read per request: the credential is filled in after a join request is approved.
        if (configuration.AwaitingApproval) throw new InvalidOperationException("Agent is awaiting approval and has no credential yet.");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AgentToken);
        var response = await client.SendAsync(request, cancellationToken);
        // Never put response bodies, credentials, or script bodies in logs/exceptions.
        if (!response.IsSuccessStatusCode) { var status = (int)response.StatusCode; response.Dispose(); throw new AgentApiException(status); }
        return response;
    }
    public async Task<JsonElement> CheckInAsync(object body, CancellationToken ct) => await SendAsync<JsonElement>(HttpMethod.Post, "checkin", body, ct);
    /// <summary>With <paramref name="waitSeconds"/> &gt; 0 the server holds the request (long-poll) until a job is queued
    /// or the wait elapses. It must stay well below the 30 s client timeout. 0 asks for an immediate answer.</summary>
    public async Task<AgentJob?> ClaimAsync(CancellationToken ct, int waitSeconds = 0) =>
        (await SendAsync<ClaimResponse>(HttpMethod.Post, "jobs/claim", waitSeconds > 0 ? new { waitSeconds } : new { }, ct))?.Job;
    /// <summary>One raw chunk (at most 4 MiB) of the file requested by a <c>files</c> download job.</summary>
    public async Task UploadFileChunkAsync(string id, long sequence, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"jobs/{Guid.Parse(id):D}/file/{sequence}") { Content = new ReadOnlyMemoryContent(data) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await SendAuthorizedAsync(request, ct);
    }
    public Task FinishFileAsync(string id, object body, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Post, $"jobs/{Guid.Parse(id):D}/file/complete", body, ct);
    public Task<StartResponse?> StartAsync(AgentJob job, CancellationToken ct) => SendAsync<StartResponse>(HttpMethod.Post, $"jobs/{Guid.Parse(job.Id):D}/start", new { job.DispatchToken }, ct);
    public Task UploadAsync(string id, OutputChunk chunk, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Put, $"jobs/{Guid.Parse(id):D}/output/{chunk.Sequence}", new { chunk.Stream, chunk.Text }, ct);
    public Task CompleteAsync(string id, JobCompletion completion, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Post, $"jobs/{Guid.Parse(id):D}/complete", completion, ct);
    public void Dispose() => client.Dispose();
}

/// <summary>Sends a download job's bytes. Each upload is retried (delivery, never execution): the server
/// accepts an identical duplicate chunk and rejects different bytes for the same sequence.</summary>
public sealed class AgentFileTransfer(AgentApi api, string jobId) : IFileTransfer
{
    public Task UploadChunkAsync(long sequence, ReadOnlyMemory<byte> data, CancellationToken ct) =>
        RetryAsync(() => api.UploadFileChunkAsync(jobId, sequence, data, ct), ct);
    public Task FinishAsync(string name, long sizeBytes, string sha256, long chunks, CancellationToken ct) =>
        RetryAsync(() => api.FinishFileAsync(jobId, new { name, sizeBytes, sha256, chunks }, ct), ct);
    private static async Task RetryAsync(Func<Task> send, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { await send(); return; }
            catch (Exception exception) when (attempt < 5 && !ct.IsCancellationRequested &&
                (exception is HttpRequestException or TaskCanceledException || exception is AgentApiException { StatusCode: >= 500 or 429 }))
            {
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2), ct);
            }
        }
    }
}

public sealed class AgentApiException(int statusCode) : Exception($"Agent API request failed with HTTP {statusCode}.")
{
    public int StatusCode { get; } = statusCode;
}

public static class AgentVersion
{
    public static string Value { get; } = (typeof(AgentVersion).Assembly
        .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
        .Cast<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion ?? "0.1.0").Split('+')[0];
}
