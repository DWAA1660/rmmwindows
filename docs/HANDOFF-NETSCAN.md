# Network scanner handoff (2026-11-20)

Requested by the user: pick one or more endpoints and see every device/port each can reach (nmap-style), with targets that can be whole subnets, ranges or single IPs, saved target and port lists, a common-ports catalog on the website, and saved "custom runs" such as a firewall test that every computer can reach the printer on 9100.

## Design

- **No agent update.** A scan is one ordinary `powershell` job per source computer, created by `POST /api/netscans`. The script is written entirely by the server (`server/src/netscan.mjs` `scanScript`); only validated numbers/booleans are embedded, base64-encoded JSON. Browsers never supply script text. Every agent version that runs PowerShell jobs (all current ones) can scan. Jobs are at-most-once like every job; nothing is requeued; a lost or interrupted scan is simply re-run by the operator.
- **What the script does (read-only):** lists the computer's IPv4 adapters; optional ICMP ping sweep (`Ping.SendPingAsync`); TCP connect probes in batches (`TcpClient.ConnectAsync`, `SIO_TCP_INITIAL_RTO` with no SYN retransmissions so a closed port's RST fails immediately instead of Windows' ~1 s retry); reads the ARP cache (`Get-NetNeighbor`) for MACs and layer-2-only devices; optional reverse DNS. Outcomes: open (connected), closed (refused → host is up), filtered (timeout/other). UDP is not probed.
- **Output protocol:** lines `RMMSCAN {json}` on stdout: `start` (computer, adapters), `progress` (phase ping|tcp|names, done/total, ≤1/s), `host` (ip, rtt, ttl, open[], closed[] when ≤64, closedCount, filtered), `arp` (items ip/mac), `names` (items ip/name), `end`, `error`. Output is retained like any job output (full download still available in Activity).
- **Server parsing:** `GET /netscans/:id` folds each job's stdout incrementally (in-memory cache of the last read sequence per job, ≤300 jobs), tolerating lines split across chunks, PowerShell single-element arrays and garbage lines. Pass/fail is computed from the parsed hosts.
- **Limits:** ≤64 target entries; a subnet must be /20 or smaller; ≤4,096 unique addresses after merging overlaps; ≤1,024 ports; ≤131,072 address×port probes; loopback, 0/8, multicast and reserved ranges refused. Speeds: gentle 64 sockets/1500 ms, normal 256/800 ms, fast 512/400 ms. Job timeout = 1.5 × worst-case estimate + 120 s, clamped 300–14,400 s.
- **Targets:** CIDR scans every usable address (network/broadcast skipped for /30 and larger); ranges `a.b.c.d-e.f.g.h` or short `a.b.c.d-h`; single IP.
- **Tests:** `expect` `discover` (report only), `reachable` (every address must accept every port) or `blocked` (none may). Each source computer gets its own verdict; the scan fails if any computer fails; failures list up to 500 `ip:port` pairs (count is exact).
- **Saved items (schema v12):** `netscan_presets` kind `targets` | `ports` | `test` (unique name per kind, case-insensitive). Tests store targets, ports, expectation, options and optionally remembered computers. Scans live in `netscans` + `netscan_jobs` (job links) and also create a normal `job_runs` row, so they appear in Activity.
- **Roles:** viewers can read scans/presets; operators/admins create/edit/delete presets and run scans (existing middleware). Audit: `netscan.created`, `netscan.preset.created|updated|deleted`.

## Console

Fleet → **Network scanner** (`web/src/NetworkScanner.tsx`, model `web/src/netscanModel.ts`): four-step builder (computers, targets with fleet-subnet suggestions and saved lists, ports with profiles/catalog/custom ranges, expectation + options) with a live address/probe/time estimate; Saved tests with one-click Run (pre-selects remembered computers); Recent scans with live progress. Results: per-computer progress cards and verdicts, failure list, stats, Hosts table (device/OS guess from ports+TTL, MAC, ping, risk-coloured ports, expandable hardening advice), Subnet map (16×16 grid per /24), Exposure (open services worst-first with advice), Compare computers (differences between sources), Source network (adapters/gateways). CSV export neutralizes spreadsheet formulas.

## Verification (2026-11-20)

- `server`: `node --test test/*.test.mjs` 61/61 (new `test/netscan.test.mjs`: target/port parsing and limits, script config embedding, output folding, verdicts, idempotent scan creation, live results from split chunks, roles, presets CRUD/uniqueness). Schema assertions moved to v12.
- `web`: `node --test test/*.test.mjs` 47/47 (new `test/netscan-model.test.mjs`), `tsc -b`, `vite build` pass.
- Real Windows PowerShell 5.1 on the developer PC: the generated script found the PC itself (TTL 128, 135/445 open), the gateway (ARP MAC) and resolved names; closed ports reported instantly; same result under the agent-style `& script | Out-Default` wrapper with exit 0.
- Local QA server (temp DB, synthetic endpoints; one agent loop ran the real script on the developer PC, a second replayed it with ports removed to simulate a firewalled VLAN): /24 × Top 20 scan finished in about 35 s with 37 devices; saved "must reach printer:9100" test passed on both computers; "must block 445/3389 on a DC" failed for the unrestricted computer and passed for the simulated VLAN; phone width had no horizontal overflow.
- **Not yet verified** on a production agent through the real agent service, or across real VLANs/firewalls.

## Limitations / follow-ups

- TCP only (no UDP: SNMP, DNS-over-UDP, NetBIOS name, SSDP). No service/banner/version detection; device and OS labels are guesses from ports and TTL.
- A running scan cannot be stopped from the console (queued ones can be cancelled in Activity); it ends at its timeout.
- Saved tests run manually; scheduling them (alerting on a changed verdict) would be a natural next step.
