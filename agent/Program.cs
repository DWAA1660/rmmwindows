using LibraryRmm.Agent;
using Microsoft.Extensions.Hosting;

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
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
