using System.Net;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace LibraryRmm.Agent;

internal sealed record JoinResponse(string Status, string? EndpointId, string? AgentToken);

/// <summary>
/// Tokenless enrollment. A freshly installed agent (agent.json has a joinSecret but no
/// agentToken) asks the server to join and waits for an operator to approve it in the console.
/// No job can be claimed before approval because the agent has no credential to claim with.
/// </summary>
internal static class AgentJoin
{
    internal static readonly TimeSpan PendingInterval = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan DeniedInterval = TimeSpan.FromMinutes(15);
    internal static readonly TimeSpan ErrorInterval = TimeSpan.FromMinutes(1);

    public static async Task WaitForApprovalAsync(AgentConfiguration configuration, ILogger logger, CancellationToken ct,
        HttpMessageHandler? handler = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        delay ??= Task.Delay;
        using var client = new HttpClient(handler ?? new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
        {
            BaseAddress = new Uri(configuration.ServerUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30)
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("LibraryRmm-Agent/" + AgentVersion.Value);
        string? lastStatus = null;
        while (configuration.AwaitingApproval)
        {
            ct.ThrowIfCancellationRequested();
            TimeSpan wait;
            try
            {
                using var response = await client.PostAsJsonAsync("api/agent/join", new
                {
                    deviceId = configuration.DeviceId, joinSecret = configuration.JoinSecret, hostname = Environment.MachineName,
                    osName = RuntimeInformation.OSDescription, osVersion = Environment.OSVersion.Version.ToString(), domain = DomainName(),
                    agentVersion = AgentVersion.Value
                }, AgentConfiguration.Json, ct);
                if (response.StatusCode != HttpStatusCode.OK) throw new AgentApiException((int)response.StatusCode);
                var result = await response.Content.ReadFromJsonAsync<JoinResponse>(AgentConfiguration.Json, ct)
                    ?? throw new InvalidDataException("Empty join response.");
                if (result.Status == "approved" && Guid.TryParse(result.EndpointId, out _) && !string.IsNullOrWhiteSpace(result.AgentToken))
                {
                    // Persist BEFORE using the credential so a crash cannot lose an issued token.
                    SaveCredential(configuration, result.EndpointId!, result.AgentToken!);
                    configuration.EndpointId = result.EndpointId!;
                    configuration.AgentToken = result.AgentToken!;
                    logger.LogInformation("Join request approved; enrolled as endpoint {EndpointId}.", result.EndpointId);
                    return;
                }
                if (result.Status != lastStatus)
                {
                    if (result.Status == "denied") logger.LogWarning("Join request was denied in the console. Checking again every {Minutes} minutes in case it is approved later.", DeniedInterval.TotalMinutes);
                    else logger.LogInformation("Waiting for an operator to approve this computer under Add endpoints in the console.");
                    lastStatus = result.Status;
                }
                wait = result.Status == "denied" ? DeniedInterval : PendingInterval;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception exception)
            {
                logger.LogWarning("Join request failed ({FailureType}); retrying.", exception is AgentApiException api ? $"HTTP {api.StatusCode}" : exception.GetType().Name);
                wait = ErrorInterval;
            }
            await delay(wait, ct);
        }
    }

    /// <summary>Atomically adds the issued credential to agent.json, keeping every other field.</summary>
    internal static void SaveCredential(AgentConfiguration configuration, string endpointId, string agentToken)
    {
        var path = Path.Combine(configuration.DataDirectory, "agent.json");
        var document = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidDataException("agent.json is not an object.");
        document["endpointId"] = endpointId;
        document["agentToken"] = agentToken;
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, document.ToJsonString());
        File.Move(temporary, path, overwrite: true);
    }

    private static string DomainName()
    {
        try { return IPGlobalProperties.GetIPGlobalProperties().DomainName ?? ""; }
        catch (NetworkInformationException) { return ""; }
    }
}
