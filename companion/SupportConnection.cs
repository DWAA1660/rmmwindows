using System.Net.WebSockets;
using System.Text.Json;

namespace LibraryRmm.Support;

internal sealed class SupportConnection(SupportBootstrap bootstrap) : IDisposable
{
    private readonly ClientWebSocket socket = new();
    private readonly HttpMessageInvoker transport = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
    private readonly SemaphoreSlim sending = new(1, 1);
    public bool Connected => socket.State == WebSocketState.Open;
    public async Task ConnectAsync(CancellationToken ct)
    {
        socket.Options.AddSubProtocol("rmm-support");
        socket.Options.SetRequestHeader("Authorization", "Bearer " + bootstrap.Grant.Credential);
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
        socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(15);
        await socket.ConnectAsync(bootstrap.Validate(DateTimeOffset.UtcNow), transport, ct);
    }
    public Task SendJsonAsync(object value, CancellationToken ct) => SendAsync(JsonSerializer.SerializeToUtf8Bytes(value, SupportBootstrap.Json), WebSocketMessageType.Text, ct);
    public Task SendFrameAsync(byte[] frame, CancellationToken ct)
    {
        if (frame.Length is < 4 or > 1024 * 1024 || frame[0] != 0xff || frame[1] != 0xd8)
            throw new InvalidDataException("Invalid support JPEG frame.");
        return SendAsync(frame, WebSocketMessageType.Binary, ct);
    }
    private async Task SendAsync(byte[] bytes, WebSocketMessageType type, CancellationToken ct)
    {
        await sending.WaitAsync(ct);
        try { await socket.SendAsync(bytes.AsMemory(), type, true, ct); }
        finally { sending.Release(); }
    }
    public async Task ReceiveAsync(Func<JsonElement, Task> onMessage, CancellationToken ct)
    {
        var buffer = new byte[4096];
        while (!ct.IsCancellationRequested)
        {
            using var message = new MemoryStream();
            ValueWebSocketReceiveResult received;
            do
            {
                received = await socket.ReceiveAsync(buffer.AsMemory(), ct);
                if (received.MessageType == WebSocketMessageType.Close) return;
                if (received.MessageType != WebSocketMessageType.Text || message.Length + received.Count > 16384)
                    throw new InvalidDataException("Invalid support relay message.");
                message.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            using var document = JsonDocument.Parse(message.ToArray());
            await onMessage(document.RootElement);
        }
    }
    public void Abort() => socket.Abort();
    public void Dispose() { socket.Dispose(); transport.Dispose(); sending.Dispose(); }
}
