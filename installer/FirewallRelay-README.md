# Library RMM Windows firewall relay

The relay receives WatchGuard syslog on the library LAN and uploads it to RMM over HTTPS. Use an always-on Windows PC with a reserved or static LAN address, a Domain or Private network profile, and outbound HTTPS access to RMM.

1. In RMM, open **Fleet → Firewall**. Add a Firebox with the IPv4 address the Firebox uses to send syslog on the LAN. Under **Relay setup**, generate a key and keep that screen open. RMM displays the key once.
2. Extract the entire ZIP. Open **Windows PowerShell as administrator** in the extracted folder. After verifying the ZIP came from your RMM dashboard, run:

   ```powershell
   Unblock-File -LiteralPath .\Install-FirewallRelay.ps1
   .\Install-FirewallRelay.ps1 -ListenAddress <Windows-PC-IPv4> -FireboxAddress <Firebox-IPv4>
   ```

   Replace the placeholders with IP addresses and enter the relay key at the hidden prompt. The installer creates the **LibraryRmmFirewallRelay** scheduled task and a Windows Firewall rule restricted to the selected receiver interface and Firebox IPv4. It starts the task immediately and at boot under Local Service. No reboot is needed.
3. In Fireware Web UI, open **System → Logging → Syslog Server**. Add the Windows PC's LAN IP and UDP port **5514**, select **Syslog**, and select **Local1** for **Traffic**. Set other categories to **NONE** for this destination. Keep existing destinations. Enable logging on the policies you want to observe. [WatchGuard syslog settings](https://www.watchguard.com/help/docs/help-center/en-us/content/en-us/Fireware/logging/send_logs_to_syslog_c.html).
4. Generate traffic on a policy with logging enabled. In RMM, click **Refresh** and check **Last log received** and **Traffic logs** for the Firebox. A log's **Raw log** disclosure shows the original syslog record.

## Troubleshooting

- In Task Scheduler, look for **LibraryRmmFirewallRelay**. Its status file is `%ProgramFiles%\LibraryRmmFirewallRelay\Status\status.json`. It includes the listener address, last HTTPS response, pending events, and drops. A 401 usually indicates an invalid or replaced key. Rerun setup with the current key.
- The relay keeps up to 1,000 datagrams in memory during an HTTPS interruption. A Windows restart discards pending datagrams, and new arrivals are dropped when that queue fills. RMM deduplicates successful HTTPS retransmissions while the original entry is retained.
- Run `Unblock-File -LiteralPath .\Uninstall-FirewallRelay.ps1` and then `.\Uninstall-FirewallRelay.ps1` from elevated Windows PowerShell to remove the task, the relay files, and its Windows Firewall rule. Revoke the key in RMM when retiring a relay. Change or remove the Firebox syslog destination separately.
