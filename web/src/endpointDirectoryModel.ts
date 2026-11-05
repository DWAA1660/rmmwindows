type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(text).filter((item): item is string => item !== null)
    : [];
const bool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Missing data is unknown, never a false domain/reboot diagnostic. */
export function endpointDiagnostics(value: unknown) {
  const inventory = record(value),
    directory = record(inventory.directory),
    hardware = record(inventory.hardware);
  const version = text(inventory.agentVersion);
  const versionNumbers = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
    ?.slice(1)
    .map(Number);
  const versionSupportsDetails = versionNumbers
    ? versionNumbers[0] > 0 ||
      versionNumbers[1] > 1 ||
      (versionNumbers[1] === 1 && versionNumbers[2] >= 7)
    : null;
  const joined = bool(inventory.domainJoined);
  const collected = text(inventory.inventoryCollectedAt);
  const inventoryCollectedAt =
    collected && Number.isFinite(Date.parse(collected)) ? collected : null;
  const networkAdapters = Array.isArray(inventory.networkAdapters)
    ? inventory.networkAdapters
        .map((item) => {
          const adapter = record(item);
          return {
            name: text(adapter.name),
            mac: text(adapter.mac),
            ipv4: list(adapter.ipv4),
            gateways: list(adapter.gateways),
            dnsServers: list(adapter.dnsServers),
            dhcpEnabled: bool(adapter.dhcpEnabled),
          };
        })
        .filter((adapter) => adapter.name || adapter.mac || adapter.ipv4.length)
    : [];
  const pendingReboot = bool(inventory.pendingReboot),
    uptimeSeconds = nonnegative(inventory.uptimeSeconds);
  const hasExtendedReport =
    Object.keys(directory).length > 0 ||
    Object.keys(hardware).length > 0 ||
    networkAdapters.length > 0 ||
    inventoryCollectedAt !== null ||
    pendingReboot !== null ||
    uptimeSeconds !== null;
  return {
    membership:
      joined === true
        ? ("joined" as const)
        : joined === false
          ? ("workgroup" as const)
          : ("unknown" as const),
    domain: text(inventory.domain),
    agentVersion: version,
    requiresUpgrade: versionSupportsDetails === false,
    hasExtendedReport,
    inventoryCollectedAt,
    uptimeSeconds,
    directory: {
      distinguishedName: text(directory.distinguishedName),
      canonicalName: text(directory.canonicalName),
      organizationalUnits: list(directory.organizationalUnits),
      domainController: text(directory.domainController),
      site: text(directory.site),
      error: text(directory.error),
    },
    hardware: {
      manufacturer: text(hardware.manufacturer),
      model: text(hardware.model),
      serialNumber: text(hardware.serialNumber),
      biosVersion: text(hardware.biosVersion),
    },
    networkAdapters,
    pendingReboot,
    pendingRebootReasons: list(inventory.pendingRebootReasons),
  };
}

export function diagnosticUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0)
    return "Not reported";
  const minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
