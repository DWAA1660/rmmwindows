using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace LibraryRmm.Agent;

public sealed record AgentConfiguration
{
    public required string ServerUrl { get; init; }
    public required string DeviceId { get; init; }
    public required string AgentToken { get; init; }
    public required string EndpointId { get; init; }
    public int PollSeconds { get; init; } = 10;
    public int InventoryMinutes { get; init; } = 15;
    public bool AllowInsecureLocalhost { get; init; }
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
        if (!Guid.TryParse(DeviceId, out _) || !Guid.TryParse(EndpointId, out _) || string.IsNullOrWhiteSpace(AgentToken))
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
    public AgentApi(AgentConfiguration configuration) : this(configuration, new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false }) { }
    internal AgentApi(AgentConfiguration configuration, HttpMessageHandler handler)
    {
        client = new HttpClient(handler) { BaseAddress = new Uri(configuration.ServerUrl.TrimEnd('/') + "/api/agent/"), Timeout = TimeSpan.FromSeconds(30) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AgentToken);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("LibraryRmm-Agent/" + AgentVersion.Value);
    }

    public async Task<T?> SendAsync<T>(HttpMethod method, string path, object body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body, options: AgentConfiguration.Json) };
        using var response = await client.SendAsync(request, cancellationToken);
        // Never put response bodies, credentials, or script bodies in logs/exceptions.
        if (!response.IsSuccessStatusCode) throw new AgentApiException((int)response.StatusCode);
        return await response.Content.ReadFromJsonAsync<T>(AgentConfiguration.Json, cancellationToken);
    }
    public Task CheckInAsync(object body, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Post, "checkin", body, ct);
    public async Task<AgentJob?> ClaimAsync(CancellationToken ct) => (await SendAsync<ClaimResponse>(HttpMethod.Post, "jobs/claim", new { }, ct))?.Job;
    public Task<StartResponse?> StartAsync(AgentJob job, CancellationToken ct) => SendAsync<StartResponse>(HttpMethod.Post, $"jobs/{Guid.Parse(job.Id):D}/start", new { job.DispatchToken }, ct);
    public Task UploadAsync(string id, OutputChunk chunk, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Put, $"jobs/{Guid.Parse(id):D}/output/{chunk.Sequence}", new { chunk.Stream, chunk.Text }, ct);
    public Task CompleteAsync(string id, JobCompletion completion, CancellationToken ct) => SendAsync<JsonElement>(HttpMethod.Post, $"jobs/{Guid.Parse(id):D}/complete", completion, ct);
    public void Dispose() => client.Dispose();
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
