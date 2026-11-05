using LibraryRmm.Agent;
using Microsoft.Extensions.Hosting;

// Must run before any other argument check: the relayed program's own arguments are arbitrary
// (they could even contain "--self-test").
if (args.Length >= 1 && args[0] == "--console-relay")
{
    Environment.ExitCode = ConsoleRelay.Run(args[1..]);
    return;
}

if (args.Length == 2 && args[0] == "--self-test-native-progress")
{
    await AgentSelfTests.RunNativeProgressChildAsync(args[1]);
    return;
}

if (args.Length >= 1 && (args[0] == "--self-test-buffered-progress" || args[0].StartsWith("--self-test-relay-", StringComparison.Ordinal)))
{
    Environment.ExitCode = await ConsoleRelayTests.RunChildAsync(args);
    return;
}

if (args.Contains("--self-test", StringComparer.Ordinal))
{
    Environment.ExitCode = await AgentSelfTests.RunAsync();
    return;
}

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("The endpoint agent requires Windows.");
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "LibraryRmmAgent");
builder.Services.AddSingleton(AgentConfiguration.Load(args));
builder.Services.AddSingleton<AgentApi>();
builder.Services.AddSingleton<OutputSpool>();
builder.Services.AddSingleton<PowerShellRunner>();
builder.Services.AddSingleton<InventoryCollector>();
builder.Services.AddSingleton<TerminalManager>();
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
