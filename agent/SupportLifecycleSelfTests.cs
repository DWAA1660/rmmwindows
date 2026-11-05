using System.Diagnostics;
using System.IO.Pipes;
using System.Text;

namespace LibraryRmm.Agent;

internal static class SupportLifecycleSelfTests
{
    public static async Task RunAsync()
    {
        // A disconnected bootstrap pipe with buffered output reproduces the sign-out cleanup
        // fault without launching a helper, changing a service, capturing or injecting input.
        var pipe = new NamedPipeServerStream("Rmm-Cleanup-Test-" + Guid.NewGuid().ToString("N"), PipeDirection.InOut);
        var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, leaveOpen: true);
        var writer = new StreamWriter(pipe, Encoding.UTF8, 1024, leaveOpen: true);
        writer.Write("buffered service heartbeat");
        var channel = new HelperChannel(pipe, reader, writer, new Process());
        channel.Dispose();
        await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(channel.Dispose)));
        channel.Kill();
        if (await channel.TryWriteAsync("SERVICE-ALIVE", CancellationToken.None))
            throw new InvalidOperationException("Disposed support channel accepted a heartbeat.");
    }
}
