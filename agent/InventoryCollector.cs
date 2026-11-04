using System.Text;
using System.Text.Json;

namespace LibraryRmm.Agent;

public sealed class InventoryCollector(AgentConfiguration configuration, PowerShellRunner runner)
{
    private readonly SemaphoreSlim collectionGate = new(1, 1);
    private JsonElement? cached;
    private DateTimeOffset collectedAt = DateTimeOffset.MinValue;

    public async Task<JsonElement> CollectAsync(bool force, CancellationToken ct)
    {
        await collectionGate.WaitAsync(ct);
        try
        {
            if (!force && cached.HasValue && DateTimeOffset.UtcNow - collectedAt < TimeSpan.FromMinutes(configuration.InventoryMinutes)) return cached.Value;
            var directory = Path.Combine(configuration.DataDirectory, "inventory-work");
            var output = new StringBuilder();
            var errors = new StringBuilder();
            var result = await runner.RunScriptAsync(Script.Replace("__AGENT_VERSION__", AgentVersion.Value, StringComparison.Ordinal), directory, (stream, value) =>
            {
                var target = stream == "stderr" ? errors : output;
                if (target.Length + value.Length > 16 * 1024 * 1024) throw new InvalidDataException("Inventory response exceeded 16 MiB; collection failed explicitly.");
                target.Append(value);
                return Task.CompletedTask;
            }, 120, ct);
            if (result.Interrupted || result.ExitCode != 0 || errors.Length > 0)
                throw new InvalidOperationException("Windows inventory collection failed. Review CIM/registry permissions and Windows health.");
            using var document = JsonDocument.Parse(output.ToString());
            cached = document.RootElement.Clone();
            collectedAt = DateTimeOffset.UtcNow;
            return cached.Value;
        }
        finally { collectionGate.Release(); }
    }

    public static string BootId(JsonElement inventory) => inventory.TryGetProperty("bootTime", out var boot) && boot.ValueKind == JsonValueKind.String
        ? boot.GetString() ?? "unknown" : "unknown";

    private const string Script = """
        $ErrorActionPreference = 'Stop'
        $os = Get-CimInstance Win32_OperatingSystem
        $computer = Get-CimInstance Win32_ComputerSystem
        $cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.LoadPercentage } | Where-Object { $null -ne $_ })
        $cpuPercent = if ($cpu.Count -gt 0) { [Math]::Round(($cpu | Measure-Object -Average).Average, 1) } else { $null }
        $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
            @{ name = $_.DeviceID; label = $_.VolumeName; totalBytes = [long]$_.Size; freeBytes = [long]$_.FreeSpace }
        })
        $software = @()
        foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
            $software += @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } | ForEach-Object {
                    @{ name = [string]$_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher; installDate = [string]$_.InstallDate }
                })
        }
        # Include packages installed only for currently loaded user profiles. Offline profiles
        # are intentionally not mounted or modified by this read-only inventory pass.
        foreach ($profile in @(Get-ChildItem Registry::HKEY_USERS -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^S-1-5-21-.*-\d+$' })) {
            foreach ($relative in @('Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
                $software += @(Get-ItemProperty -Path ($profile.PSPath + '\' + $relative) -ErrorAction SilentlyContinue |
                    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } | ForEach-Object {
                        @{ name = [string]$_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher; installDate = [string]$_.InstallDate }
                    })
            }
        }
        $software = @($software | Sort-Object { $_.name }, { $_.version }, { $_.publisher } -Unique)
        $addresses = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
            ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
            Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
            ForEach-Object { $_.Address.ToString() } | Sort-Object -Unique)
        @{
            hostname = $env:COMPUTERNAME
            osName = [string]$os.Caption
            osVersion = [string]$os.Version
            architecture = [string]$os.OSArchitecture
            domain = [string]$computer.Domain
            domainJoined = [bool]$computer.PartOfDomain
            ipv4 = $addresses
            loggedOnUser = [string]$computer.UserName
            bootTime = $os.LastBootUpTime.ToUniversalTime().ToString('o')
            cpuPercent = $cpuPercent
            memoryTotalBytes = [long]$os.TotalVisibleMemorySize * 1024
            memoryUsedBytes = ([long]$os.TotalVisibleMemorySize - [long]$os.FreePhysicalMemory) * 1024
            agentVersion = '__AGENT_VERSION__'
            disks = $disks
            software = $software
        } | ConvertTo-Json -Depth 8 -Compress
        """;
}
