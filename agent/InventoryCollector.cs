using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
            var enriched = JsonNode.Parse(document.RootElement.GetRawText())!.AsObject();
            var joined = document.RootElement.TryGetProperty("domainJoined", out var membership) && membership.ValueKind == JsonValueKind.True;
            var directoryDetails = InventoryDirectory.Empty();
            if (joined)
            {
                var directoryOutput = new StringBuilder();
                var directoryErrors = new StringBuilder();
                try
                {
                    var script = InventoryDirectory.BuildScript(Environment.MachineName);
                    var probe = await runner.RunScriptAsync(script, Path.Combine(directory, "directory"), (stream, value) =>
                    {
                        var target = stream == "stderr" ? directoryErrors : directoryOutput;
                        if (target.Length + value.Length > 128 * 1024) throw new InvalidDataException("Directory probe exceeded its bounded result size.");
                        target.Append(value); return Task.CompletedTask;
                    }, InventoryDirectory.TimeoutSeconds, ct);
                    ct.ThrowIfCancellationRequested();
                    directoryDetails = InventoryDirectory.ParseOutput(directoryOutput.ToString(), probe.Interrupted, probe.ExitCode != 0 || directoryErrors.Length > 0);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception exception) when (exception is not OutOfMemoryException)
                {
                    // Directory discovery is optional. It must not drop local inventory or an
                    // endpoint heartbeat when the computer is off its domain network.
                    directoryDetails = InventoryDirectory.Empty("Active Directory lookup unavailable.");
                }
            }
            enriched["directory"] = JsonSerializer.SerializeToNode(directoryDetails, AgentConfiguration.Json);
            cached = JsonSerializer.SerializeToElement(enriched, AgentConfiguration.Json);
            collectedAt = DateTimeOffset.UtcNow;
            return cached.Value;
        }
        finally { collectionGate.Release(); }
    }

    public static string BootId(JsonElement inventory) => inventory.TryGetProperty("bootTime", out var boot) && boot.ValueKind == JsonValueKind.String
        ? boot.GetString() ?? "unknown" : "unknown";

    internal const string Script = """
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
        function Limited-Text($value, [int]$maximum) {
            if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { return $null }
            $text = [string]$value
            if ($text.Length -gt $maximum) { return $text.Substring(0, $maximum) }
            return $text
        }
        $bios = $null
        try { $bios = Get-CimInstance Win32_BIOS -OperationTimeoutSec 5 -ErrorAction Stop | Select-Object -First 1 } catch { }
        $networkAdapters = @()
        foreach ($adapter in @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } | Select-Object -First 128)) {
            try {
                $properties = $adapter.GetIPProperties()
                $dhcp = $null
                try { $dhcp = [bool]$properties.GetIPv4Properties().IsDhcpEnabled } catch { }
                $networkAdapters += @{
                    name = Limited-Text $adapter.Name 512
                    mac = Limited-Text ($adapter.GetPhysicalAddress().ToString() -replace '(..)(?=.)', '$1:') 100
                    ipv4 = @($properties.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.Address.ToString() } | Select-Object -First 128)
                    gateways = @($properties.GatewayAddresses | ForEach-Object { $_.Address.ToString() } | Select-Object -First 128)
                    dnsServers = @($properties.DnsAddresses | ForEach-Object { $_.ToString() } | Select-Object -First 128)
                    dhcpEnabled = $dhcp
                }
            } catch { }
        }
        $pendingRebootReasons = New-Object 'System.Collections.Generic.List[string]'
        $rebootKnown = $true
        foreach ($indicator in @(
            @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'; reason = 'Component servicing requires a reboot' },
            @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'; reason = 'Windows Update requires a reboot' }
        )) {
            try { if (Test-Path -LiteralPath $indicator.path -ErrorAction Stop) { $pendingRebootReasons.Add($indicator.reason) } }
            catch { $rebootKnown = $false }
        }
        try {
            $sessionManager = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction Stop
            if ($sessionManager.PendingFileRenameOperations -or $sessionManager.PendingFileRenameOperations2) { $pendingRebootReasons.Add('Pending file rename operations') }
        } catch { $rebootKnown = $false }
        try {
            $activeName = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -ErrorAction Stop).ComputerName
            $configuredName = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -ErrorAction Stop).ComputerName
            if ($activeName -and $configuredName -and $activeName -ne $configuredName) { $pendingRebootReasons.Add('Computer name change requires a reboot') }
        } catch { $rebootKnown = $false }
        try {
            $netlogon = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Netlogon' -ErrorAction Stop
            if ($netlogon.PSObject.Properties['JoinDomain'] -or $netlogon.PSObject.Properties['AvoidSpnSet']) { $pendingRebootReasons.Add('Domain membership change requires a reboot') }
        } catch { $rebootKnown = $false }
        $pendingReboot = if ($pendingRebootReasons.Count -gt 0) { $true } elseif ($rebootKnown) { $false } else { $null }
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
            inventoryCollectedAt = [DateTime]::UtcNow.ToString('o')
            uptimeSeconds = [Math]::Max(0, [Math]::Floor(([DateTime]::UtcNow - $os.LastBootUpTime.ToUniversalTime()).TotalSeconds))
            hardware = @{
                manufacturer = Limited-Text $computer.Manufacturer 256
                model = Limited-Text $computer.Model 512
                serialNumber = Limited-Text $bios.SerialNumber 256
                biosVersion = Limited-Text $bios.SMBIOSBIOSVersion 512
            }
            networkAdapters = @($networkAdapters)
            pendingReboot = $pendingReboot
            pendingRebootReasons = @($pendingRebootReasons.ToArray())
        } | ConvertTo-Json -Depth 8 -Compress
        """;
}

internal sealed record InventoryDirectoryDetails(string? DistinguishedName, string? CanonicalName, string[] OrganizationalUnits, string? DomainController, string? Site, string? Error);

internal static class InventoryDirectory
{
    internal const int TimeoutSeconds = 5;
    internal static InventoryDirectoryDetails Empty(string? error = null) => new(null, null, [], null, null, error);

    internal static string BuildScript(string computerName)
    {
        var filter = "(&(objectCategory=computer)(sAMAccountName=" + EscapeFilter(computerName + "$") + "))";
        return DirectoryScript.Replace("__LDAP_FILTER__", filter.Replace("'", "''", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    internal static string EscapeFilter(string value)
    {
        var result = new StringBuilder();
        foreach (var valueByte in Encoding.UTF8.GetBytes(value))
            if (valueByte is 0 or 0x28 or 0x29 or 0x2a or 0x5c || valueByte >= 0x80) result.Append('\\').Append(valueByte.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            else result.Append((char)valueByte);
        return result.ToString();
    }

    internal static InventoryDirectoryDetails ParseOutput(string output, bool timedOut, bool failed)
    {
        JsonElement? latest = null;
        foreach (var line in output.Split('\n'))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try { using var json = JsonDocument.Parse(line.Trim()); if (json.RootElement.ValueKind == JsonValueKind.Object) latest = json.RootElement.Clone(); }
            catch (JsonException) { }
        }
        var truncated = false;
        string? Text(string property, int maximum)
        {
            if (!latest.HasValue || !latest.Value.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString())) return null;
            var text = value.GetString()!;
            if (text.Length <= maximum) return text;
            truncated = true; return text[..maximum];
        }
        var dn = Text("distinguishedName", 4096);
        var canonical = Text("canonicalName", 4096);
        var controller = Text("domainController", 512);
        var site = Text("site", 512);
        var error = timedOut ? "Active Directory lookup timed out after 5 seconds; the computer may be off the domain network." : Text("error", 1000);
        if (error is null && (failed || !latest.HasValue)) error = "Active Directory lookup unavailable.";
        string[] ous = [];
        if (dn is not null)
        {
            try
            {
                ous = OrganizationalUnits(dn);
                if (ous.Length > 64 || ous.Any(value => value.Length > 512))
                { ous = ous.Take(64).Select(value => value.Length <= 512 ? value : value[..512]).ToArray(); truncated = true; }
            }
            catch (FormatException) { error ??= "The computer's Active Directory distinguished name could not be decoded."; }
        }
        if (truncated) error = "Active Directory data exceeded bounded inventory field limits; some fields are shortened.";
        return new(dn, canonical, ous, controller, site, error);
    }

    internal static string[] OrganizationalUnits(string distinguishedName)
    {
        var units = new List<string>();
        foreach (var rdn in SplitDn(distinguishedName, ','))
            foreach (var attribute in SplitDn(rdn, '+'))
            {
                var equals = attribute.IndexOf('=');
                if (equals > 0 && attribute[..equals].Trim().Equals("OU", StringComparison.OrdinalIgnoreCase)) units.Add(UnescapeDn(attribute[(equals + 1)..]));
            }
        units.Reverse(); return units.ToArray();
    }
    private static IEnumerable<string> SplitDn(string value, char separator)
    {
        var start = 0; var quoted = false;
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] == '\\') { if (++index >= value.Length) throw new FormatException("Incomplete DN escape."); continue; }
            if (value[index] == '"') quoted = !quoted;
            if (value[index] == separator && !quoted) { yield return value[start..index]; start = index + 1; }
        }
        if (quoted) throw new FormatException("Incomplete DN quote.");
        yield return value[start..];
    }
    private static string UnescapeDn(string value)
    {
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"') value = value[1..^1];
        var text = new StringBuilder();
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] != '\\') { text.Append(value[index]); continue; }
            if (++index >= value.Length) throw new FormatException("Incomplete DN escape.");
            var bytes = new List<byte>();
            while (index + 1 < value.Length && byte.TryParse(value.AsSpan(index, 2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out var decoded))
            {
                bytes.Add(decoded); index += 2;
                if (index < value.Length && value[index] == '\\' && index + 2 < value.Length && Uri.IsHexDigit(value[index + 1]) && Uri.IsHexDigit(value[index + 2])) { index++; continue; }
                break;
            }
            if (bytes.Count > 0)
            {
                try { text.Append(new UTF8Encoding(false, true).GetString(bytes.ToArray())); }
                catch (DecoderFallbackException exception) { throw new FormatException("Invalid DN UTF-8 escape.", exception); }
                index--; // The loop resumes at the first character following the hex escape run.
            }
            else text.Append(value[index]);
        }
        return text.ToString();
    }

    internal const string DirectoryScript = """
        $ErrorActionPreference = 'Stop'
        $result = @{ distinguishedName = $null; canonicalName = $null; domainController = $null; site = $null; error = $null }
        function Emit-DirectoryResult { $result | ConvertTo-Json -Depth 4 -Compress }
        $domain = $null; $controller = $null; $rootDse = $null; $searchRoot = $null; $searcher = $null
        try {
            Add-Type -AssemblyName System.DirectoryServices
            # Machine domain discovery works under LocalSystem; LOGONSERVER would describe
            # the service's logon context rather than reliably identify this computer's DC.
            $domain = [System.DirectoryServices.ActiveDirectory.Domain]::GetComputerDomain()
            $controller = $domain.FindDomainController()
            $result.domainController = [string]$controller.Name
            Emit-DirectoryResult
            $authentication = [System.DirectoryServices.AuthenticationTypes]::Secure -bor [System.DirectoryServices.AuthenticationTypes]::Signing -bor [System.DirectoryServices.AuthenticationTypes]::Sealing -bor [System.DirectoryServices.AuthenticationTypes]::ServerBind
            $rootDse = New-Object System.DirectoryServices.DirectoryEntry(('LDAP://' + $result.domainController + '/RootDSE'))
            $rootDse.AuthenticationType = $authentication
            $namingContext = [string]$rootDse.Properties['defaultNamingContext'][0]
            if (-not $namingContext) { throw 'Domain naming context unavailable.' }
            $searchRoot = New-Object System.DirectoryServices.DirectoryEntry(('LDAP://' + $result.domainController + '/' + $namingContext))
            $searchRoot.AuthenticationType = $authentication
            $searcher = New-Object System.DirectoryServices.DirectorySearcher($searchRoot)
            $searcher.Filter = '__LDAP_FILTER__'
            $searcher.SizeLimit = 1
            $searcher.ClientTimeout = [TimeSpan]::FromSeconds(2)
            $searcher.ServerTimeLimit = [TimeSpan]::FromSeconds(2)
            $searcher.ReferralChasing = [System.DirectoryServices.ReferralChasingOption]::None
            [void]$searcher.PropertiesToLoad.Add('distinguishedName')
            [void]$searcher.PropertiesToLoad.Add('canonicalName')
            $entry = $searcher.FindOne()
            if ($null -eq $entry) { $result.error = 'The computer account was not found in Active Directory.' }
            else {
                if ($entry.Properties['distinguishedname'].Count -gt 0) { $result.distinguishedName = [string]$entry.Properties['distinguishedname'][0] }
                if ($entry.Properties['canonicalname'].Count -gt 0) { $result.canonicalName = [string]$entry.Properties['canonicalname'][0] }
                if (-not $result.distinguishedName) { $result.error = 'The computer account did not return a distinguished name.' }
            }
            Emit-DirectoryResult
            try { $result.site = [string]$controller.SiteName } catch { }
        } catch [System.DirectoryServices.ActiveDirectory.ActiveDirectoryObjectNotFoundException] {
            $result.error = 'No domain controller was found for the computer domain.'
        } catch [System.UnauthorizedAccessException] {
            $result.error = 'Active Directory computer information could not be read with the endpoint machine account.'
        } catch {
            $result.error = 'Active Directory lookup unavailable (offline, access denied, or discovery failed).'
        } finally {
            foreach ($disposable in @($searcher, $searchRoot, $rootDse, $controller, $domain)) {
                if ($null -ne $disposable) { try { $disposable.Dispose() } catch { } }
            }
        }
        Emit-DirectoryResult
        """;
}
