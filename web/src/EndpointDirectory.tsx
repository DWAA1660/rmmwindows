import { useState } from "react";
import {
  Building2,
  CheckCircle2,
  Clock3,
  Copy,
  Cpu,
  Folder,
  Info,
  Network,
  Power,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  diagnosticUptime,
  endpointDiagnostics,
} from "./endpointDirectoryModel";
import "./EndpointDirectory.css";

function DiagnosticValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="ed-value">
      <span>{label}</span>
      <strong className={mono ? "ed-mono" : ""}>
        {value || <em>Not reported</em>}
      </strong>
    </div>
  );
}

/** Read-only inventory presentation. An older agent never implies negative AD/reboot results. */
export function EndpointDirectory({ inventory }: { inventory?: unknown }) {
  const data = endpointDiagnostics(inventory),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState("");
  const units = data.directory.organizationalUnits;
  const copyDistinguishedName = async () => {
    if (!data.directory.distinguishedName) return;
    try {
      await navigator.clipboard.writeText(data.directory.distinguishedName);
      setCopied(true);
      setCopyError("");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError("Select the distinguished name below and copy it manually.");
    }
  };
  return (
    <section
      className="endpoint-diagnostics"
      aria-label="Endpoint directory and diagnostics"
    >
      <header className="ed-heading">
        <div>
          <span className="ed-section-icon">
            <Network size={20} />
          </span>
          <div>
            <h3>Directory & system diagnostics</h3>
            <p>Inventory snapshots from the endpoint.</p>
          </div>
        </div>
        <span className="ed-collected">
          <Clock3 size={12} />
          {data.inventoryCollectedAt
            ? `Collected ${new Date(data.inventoryCollectedAt).toLocaleString()}`
            : "Collection time not reported"}
        </span>
      </header>
      {(data.requiresUpgrade || !data.hasExtendedReport) && (
        <div className="ed-upgrade-note" role="status">
          <Info size={16} />
          <p>
            {data.requiresUpgrade
              ? `This endpoint reports agent ${data.agentVersion}. Install agent 0.1.7 or later, then refresh inventory for OU, domain controller, hardware, and network diagnostics.`
              : "Extended diagnostics have not been received. Agent 0.1.7 or later and a fresh inventory are required. Missing values are shown as unknown."}
          </p>
        </div>
      )}
      <section className="ed-directory-card">
        <div className="ed-card-title">
          <h4>
            <Building2 size={16} />
            Active Directory
          </h4>
          <span className={`ed-membership ed-membership-${data.membership}`}>
            <i />
            {data.membership === "joined"
              ? "Domain joined"
              : data.membership === "workgroup"
                ? "Workgroup"
                : "Membership unknown"}
          </span>
        </div>
        {data.membership === "joined" ? (
          <>
            <div className="ed-ou-path">
              <span className="ed-field-label">
                Organizational unit hierarchy
              </span>
              <ol>
                <li>
                  <span className="ed-domain-node">
                    <Network size={14} />
                    <strong>{data.domain || "Domain name not reported"}</strong>
                  </span>
                </li>
                {units.map((unit, index) => (
                  <li
                    key={`${unit}-${index}`}
                    style={{ marginLeft: `${Math.min(index + 1, 8) * 14}px` }}
                  >
                    <span>
                      <Folder size={14} />
                      <strong>{unit}</strong>
                    </span>
                  </li>
                ))}
              </ol>
              {!units.length && (
                <p className="ed-ou-empty">
                  {data.hasExtendedReport && !data.directory.error
                    ? "No OU names were reported. The distinguished name may identify a default AD container."
                    : "OU location has not been reported."}
                </p>
              )}
            </div>
            <div className="ed-directory-values">
              <DiagnosticValue
                label="Domain controller"
                value={data.directory.domainController}
                mono
              />
              <DiagnosticValue label="AD site" value={data.directory.site} />
              <DiagnosticValue
                label="Canonical name"
                value={data.directory.canonicalName}
              />
            </div>
            <div className="ed-dn">
              <div>
                <span>Computer distinguished name</span>
                {data.directory.distinguishedName && (
                  <button
                    type="button"
                    onClick={() => void copyDistinguishedName()}
                  >
                    {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}{" "}
                    {copied ? "Copied" : "Copy DN"}
                  </button>
                )}
              </div>
              <code>{data.directory.distinguishedName || "Not reported"}</code>
              {copyError && <small role="status">{copyError}</small>}
            </div>
          </>
        ) : data.membership === "workgroup" ? (
          <div className="ed-membership-note">
            <ShieldCheck size={19} />
            <div>
              <strong>Windows workgroup reported</strong>
              <p>
                {data.domain ? `Workgroup: ${data.domain}. ` : ""}Active
                Directory OU and domain-controller information does not apply to
                this reported membership.
              </p>
            </div>
          </div>
        ) : (
          <div className="ed-membership-note">
            <Info size={19} />
            <div>
              <strong>Domain membership has not been reported</strong>
              <p>
                Refresh inventory to collect the Windows domain membership
                before interpreting OU or domain-controller information.
              </p>
            </div>
          </div>
        )}
        {data.directory.error && (
          <div className="ed-directory-error">
            <Info size={14} />
            <div>
              <strong>Directory lookup unavailable</strong>
              <p>{data.directory.error}</p>
              <small>
                A failed lookup does not change the reported domain membership.
              </small>
            </div>
          </div>
        )}
      </section>
      <div className="ed-system-grid">
        <section className="ed-system-card">
          <div className="ed-card-title">
            <h4>
              <Cpu size={16} />
              Hardware
            </h4>
          </div>
          <div className="ed-hardware-values">
            <DiagnosticValue
              label="Manufacturer"
              value={data.hardware.manufacturer}
            />
            <DiagnosticValue label="Model" value={data.hardware.model} />
            <DiagnosticValue
              label="Serial number"
              value={data.hardware.serialNumber}
              mono
            />
            <DiagnosticValue
              label="BIOS version"
              value={data.hardware.biosVersion}
              mono
            />
          </div>
        </section>
        <section className="ed-system-card">
          <div className="ed-card-title">
            <h4>
              <Power size={16} />
              Restart state
            </h4>
          </div>
          <div
            className={`ed-reboot-state ${data.pendingReboot === true ? "ed-reboot-pending" : ""}`}
          >
            <span>
              {data.pendingReboot === true ? (
                <Power size={20} />
              ) : data.pendingReboot === false ? (
                <CheckCircle2 size={20} />
              ) : (
                <Info size={20} />
              )}
            </span>
            <div>
              <strong>
                {data.pendingReboot === true
                  ? "Reboot pending"
                  : data.pendingReboot === false
                    ? "No pending reboot reported"
                    : "Pending reboot unknown"}
              </strong>
              <p>
                {data.pendingReboot === true
                  ? "Windows reported one or more pending-restart indicators."
                  : data.pendingReboot === false
                    ? "No checked pending-restart indicators were present in this inventory."
                    : "This inventory did not report a pending-restart diagnostic."}
              </p>
            </div>
          </div>
          {data.pendingRebootReasons.length > 0 && (
            <ul className="ed-reboot-reasons">
              {data.pendingRebootReasons.map((reason, index) => (
                <li key={`${reason}-${index}`}>{reason}</li>
              ))}
            </ul>
          )}
          <div className="ed-uptime">
            <Clock3 size={13} />
            <span>Uptime at collection</span>
            <strong>{diagnosticUptime(data.uptimeSeconds)}</strong>
          </div>
        </section>
      </div>
      <section className="ed-network-card">
        <div className="ed-card-title">
          <h4>
            <Server size={16} />
            Network adapters
          </h4>
          <span className="ed-adapter-count">
            {data.networkAdapters.length} reported
          </span>
        </div>
        {data.networkAdapters.length ? (
          <div className="ed-network-adapters">
            {data.networkAdapters.map((adapter, index) => (
              <div
                className="ed-adapter"
                key={`${adapter.name}-${adapter.mac}-${index}`}
              >
                <div className="ed-adapter-heading">
                  <span>
                    <Network size={14} />
                    <strong>{adapter.name || `Adapter ${index + 1}`}</strong>
                  </span>
                  <small>
                    {adapter.dhcpEnabled === true
                      ? "DHCP enabled"
                      : adapter.dhcpEnabled === false
                        ? "DHCP disabled"
                        : "DHCP not reported"}
                  </small>
                </div>
                <div className="ed-adapter-values">
                  <DiagnosticValue
                    label="IPv4 addresses"
                    value={adapter.ipv4.join(", ") || null}
                    mono
                  />
                  <DiagnosticValue
                    label="MAC address"
                    value={adapter.mac}
                    mono
                  />
                  <DiagnosticValue
                    label="Gateways"
                    value={adapter.gateways.join(", ") || null}
                    mono
                  />
                  <DiagnosticValue
                    label="DNS servers"
                    value={adapter.dnsServers.join(", ") || null}
                    mono
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="ed-network-empty">
            No adapter diagnostics were reported. Upgrade to agent 0.1.7 or
            later and refresh inventory if needed.
          </p>
        )}
      </section>
      <p className="ed-snapshot-note">
        <Info size={12} />
        These are read-only inventory results. They do not modify Active
        Directory, network configuration, or reboot the endpoint.
      </p>
    </section>
  );
}
