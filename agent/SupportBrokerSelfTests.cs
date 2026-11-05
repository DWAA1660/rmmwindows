using System.Text.Json;

namespace LibraryRmm.Agent;

public static class SupportBrokerSelfTests
{
    public static Task RunAsync()
    {
        var policy = new SupportSecureAttentionPolicy(true);
        var time = DateTimeOffset.UtcNow;
        var id = Guid.NewGuid().ToString("D");
        if (!policy.TryBegin(id, time) || policy.TryBegin(id, time.AddSeconds(6)) ||
            policy.TryBegin(Guid.NewGuid().ToString("D"), time.AddSeconds(4)) ||
            !policy.TryBegin(Guid.NewGuid().ToString("D"), time.AddSeconds(5))) throw new InvalidOperationException("Secure-attention replay/rate protection failed.");
        if (new SupportSecureAttentionPolicy(false).TryBegin(id, time) || policy.TryBegin("not-an-id", time.AddSeconds(30))) throw new InvalidOperationException("Secure-attention privilege/ID policy failed.");
        if (SupportSecureAttentionPolicy.ParseRequest(JsonSerializer.Serialize(new { type = "secureAttention", requestId = id })) != id)
            throw new InvalidOperationException("Valid secure-attention framing failed.");
        foreach (var invalid in new[]
        {
            "{}", "{\"type\":\"run\",\"requestId\":\"x\"}", JsonSerializer.Serialize(new { type = "secureAttention", requestId = id, command = "not permitted" }),
            new string('x', 513), "{\"type\":\"secureAttention\",\"requestId\":12}"
        })
        {
            var rejected = false;
            try { SupportSecureAttentionPolicy.ParseRequest(invalid); } catch (Exception exception) when (exception is InvalidDataException or JsonException) { rejected = true; }
            if (!rejected) throw new InvalidOperationException("Unsafe support-broker payload accepted.");
        }
        Console.WriteLine("PASS secure-attention broker framing, control scope, replay and5s limits (no registry access or SAS generated)");
        return Task.CompletedTask;
    }
}
