// Curated starter scripts for common library IT tasks. All are non-interactive, run as SYSTEM in
// Windows PowerShell 5.1, and print readable results. "changes" marks scripts that modify the computer.
export type ScriptTemplate = { id: string; name: string; category: string; description: string; changes: boolean; body: string };

export const scriptTemplates: ScriptTemplate[] = [
  {
    id: 'disk-space', category: 'Storage', changes: false, name: 'Disk space report',
    description: 'Free and used space for every fixed drive, largest folders in the user profiles.',
    body: `Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
  Select-Object DeviceID, VolumeName,
    @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},
    @{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}},
    @{n='FreePercent';e={[math]::Round(100*$_.FreeSpace/$_.Size,1)}} | Format-Table -AutoSize
'Largest profile folders:'
Get-ChildItem C:\\Users -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  [pscustomobject]@{ Profile = $_.Name; SizeGB = [math]::Round($size/1GB,2) }
} | Sort-Object SizeGB -Descending | Format-Table -AutoSize`,
  },
  {
    id: 'clean-temp', category: 'Storage', changes: true, name: 'Clean temporary files',
    description: 'Deletes files older than 7 days from Windows and user temp folders, then reports space recovered.',
    body: `$cutoff = (Get-Date).AddDays(-7)
$before = (Get-PSDrive C).Free
$folders = @("$env:WINDIR\\Temp") + (Get-ChildItem C:\\Users -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'AppData\\Local\\Temp' })
foreach ($folder in $folders | Where-Object { Test-Path $_ }) {
  $old = Get-ChildItem $folder -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff }
  $count = 0; foreach ($file in $old) { try { Remove-Item $file.FullName -Force -ErrorAction Stop; $count++ } catch { } }
  "{0}: removed {1} of {2} old files" -f $folder, $count, @($old).Count
}
"Recovered about {0:N1} MB on C:" -f (((Get-PSDrive C).Free - $before) / 1MB)`,
  },
  {
    id: 'windows-update-pending', category: 'Updates', changes: false, name: 'Pending Windows updates',
    description: 'Lists updates that are available but not installed, using the Windows Update agent.',
    body: `$session = New-Object -ComObject Microsoft.Update.Session
$result = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
"{0} update(s) pending" -f $result.Updates.Count
$result.Updates | ForEach-Object {
  [pscustomobject]@{ Title = $_.Title; KB = ($_.KBArticleIDs -join ','); SizeMB = [math]::Round($_.MaxDownloadSize/1MB,1); Reboot = $_.InstallationBehavior.RebootBehavior -ne 0 }
} | Format-Table -AutoSize -Wrap`,
  },
  {
    id: 'windows-update-history', category: 'Updates', changes: false, name: 'Recent update history',
    description: 'The last 25 Windows Update installs with their result.',
    body: `$searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
$count = $searcher.GetTotalHistoryCount()
$searcher.QueryHistory(0, [math]::Min(25, $count)) | ForEach-Object {
  [pscustomobject]@{ Date = $_.Date; Result = @('NotStarted','InProgress','Succeeded','SucceededWithErrors','Failed','Aborted')[$_.ResultCode]; Title = $_.Title }
} | Format-Table -AutoSize -Wrap`,
  },
  {
    id: 'print-spooler', category: 'Printing', changes: true, name: 'Restart print spooler and clear stuck jobs',
    description: 'Stops the spooler, removes stuck print jobs, starts it again and lists printers.',
    body: `Stop-Service Spooler -Force
Get-ChildItem "$env:WINDIR\\System32\\spool\\PRINTERS" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Start-Service Spooler
"Spooler: " + (Get-Service Spooler).Status
Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus | Format-Table -AutoSize`,
  },
  {
    id: 'printers', category: 'Printing', changes: false, name: 'Printers and ports',
    description: 'Installed printers, drivers, ports and queued jobs.',
    body: `Get-Printer | Select-Object Name, DriverName, PortName, Shared, PrinterStatus | Format-Table -AutoSize
Get-PrinterPort | Select-Object Name, PrinterHostAddress, PortNumber | Format-Table -AutoSize
Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue } | Select-Object PrinterName, DocumentName, UserName, JobStatus, SubmittedTime | Format-Table -AutoSize`,
  },
  {
    id: 'bitlocker', category: 'Security', changes: false, name: 'BitLocker status',
    description: 'Encryption state and protection status of every volume.',
    body: `Get-BitLockerVolume | Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage, EncryptionMethod, @{n='Protectors';e={($_.KeyProtector.KeyProtectorType -join ', ')}} | Format-Table -AutoSize`,
  },
  {
    id: 'defender', category: 'Security', changes: false, name: 'Microsoft Defender status',
    description: 'Antivirus state, signature age, last scans and recent detections.',
    body: `Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanEndTime, FullScanEndTime | Format-List
'Recent detections:'
Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 10 InitialDetectionTime, ProcessName, @{n='Resources';e={$_.Resources -join '; '}} | Format-Table -AutoSize -Wrap`,
  },
  {
    id: 'event-errors', category: 'Diagnostics', changes: false, name: 'Errors in the last 24 hours',
    description: 'Critical and error events from the System and Application logs, grouped by source.',
    body: `$since = (Get-Date).AddHours(-24)
$events = Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Level = 1,2; StartTime = $since } -ErrorAction SilentlyContinue
"{0} error event(s) since {1}" -f @($events).Count, $since
$events | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize
$events | Select-Object -First 20 TimeCreated, ProviderName, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} | Format-Table -AutoSize -Wrap`,
  },
  {
    id: 'network', category: 'Network', changes: false, name: 'Network diagnostics',
    description: 'IP configuration, gateway and DNS reachability, and internet connectivity.',
    body: `Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object {
  [pscustomobject]@{ Adapter = $_.InterfaceAlias; IPv4 = ($_.IPv4Address.IPAddress -join ', '); Gateway = $_.IPv4DefaultGateway.NextHop; DNS = ($_.DNSServer.ServerAddresses -join ', ') }
} | Format-Table -AutoSize
$gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop
"Gateway $gateway reachable: " + (Test-Connection $gateway -Count 2 -Quiet)
"DNS lookup (microsoft.com): " + [bool](Resolve-DnsName microsoft.com -ErrorAction SilentlyContinue)
"Internet HTTPS (443): " + (Test-NetConnection www.microsoft.com -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded`,
  },
  {
    id: 'flush-dns', category: 'Network', changes: true, name: 'Flush DNS cache',
    description: 'Clears the DNS resolver cache (fixes stale name lookups). Network stays connected.',
    body: `Clear-DnsClientCache
'DNS cache cleared. Entries now: ' + @(Get-DnsClientCache).Count`,
  },
  {
    id: 'gpupdate', category: 'Domain', changes: true, name: 'Refresh Group Policy',
    description: 'Runs gpupdate /force and shows the applied computer policies.',
    body: `gpupdate /force /wait:120
gpresult /scope computer /r`,
  },
  {
    id: 'domain-trust', category: 'Domain', changes: false, name: 'Domain trust check',
    description: 'Verifies the secure channel to the domain and shows the logon domain controller.',
    body: `$computer = Get-CimInstance Win32_ComputerSystem
"Domain: {0} (joined: {1})" -f $computer.Domain, $computer.PartOfDomain
if ($computer.PartOfDomain) {
  "Secure channel healthy: " + (Test-ComputerSecureChannel)
  nltest /dsgetdc:$($computer.Domain)
}`,
  },
  {
    id: 'sessions', category: 'Users', changes: false, name: 'Signed-in users',
    description: 'Who is signed in, idle time and session state.',
    body: `quser 2>&1
''
'Recent sign-ins (last 20):'
Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624; StartTime = (Get-Date).AddDays(-2) } -MaxEvents 200 -ErrorAction SilentlyContinue |
  Where-Object { $_.Properties[8].Value -in 2,10,11 } | Select-Object -First 20 TimeCreated, @{n='User';e={$_.Properties[6].Value + '\\' + $_.Properties[5].Value}}, @{n='Type';e={@{2='Local';10='Remote';11='Cached'}[[int]$_.Properties[8].Value]}} | Format-Table -AutoSize`,
  },
  {
    id: 'startup', category: 'Performance', changes: false, name: 'Startup programs and top processes',
    description: 'Programs that start with Windows plus the busiest processes right now.',
    body: `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User | Format-Table -AutoSize -Wrap
'Top processes by memory:'
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id, @{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB)}}, @{n='CPUSeconds';e={[math]::Round($_.CPU,1)}} | Format-Table -AutoSize`,
  },
  {
    id: 'disk-health', category: 'Hardware', changes: false, name: 'Disk health',
    description: 'Physical disk health, wear and error counters.',
    body: `Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, @{n='SizeGB';e={[math]::Round($_.Size/1GB)}} | Format-Table -AutoSize
Get-PhysicalDisk | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue | Select-Object DeviceId, Temperature, Wear, ReadErrorsTotal, WriteErrorsTotal, PowerOnHours | Format-Table -AutoSize`,
  },
  {
    id: 'system-repair', category: 'Repair', changes: true, name: 'Repair Windows system files (DISM + SFC)',
    description: 'Runs DISM RestoreHealth, then SFC /scannow, with live progress. Can take 20+ minutes; use a long timeout.',
    body: `dism /online /cleanup-image /restorehealth
sfc /scannow`,
  },
];
