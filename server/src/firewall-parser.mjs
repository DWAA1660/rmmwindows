import { isIP } from 'node:net';

const clean = (value, maximum = 200) => typeof value === 'string' ? value.trim().slice(0, maximum) || null : null;
const address = value => {
  const candidate = value?.split('|', 1)[0];
  return candidate && isIP(candidate) ? candidate : null;
};
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) =>
  value && /^\d{1,16}$/.test(value) && Number(value) <= maximum ? Number(value) : null;
const protocolName = value => {
  const protocol = value?.split('/').at(-1)?.toLowerCase();
  return protocol && /^[a-z][a-z0-9_.+-]{0,31}$/.test(protocol) ? protocol : null;
};

export function parseTraffic(raw) {
  const message = raw.replace(/^<\d{1,3}>/, '').trim();
  const attributes = Object.create(null);
  // Consume quoted values in one token, including escaped quotes. Apparent fields
  // inside a proxy message or quoted URL must not override actual log attributes.
  const bare = message.replace(/(?:^|\s)([a-z][\w_-]*)=(?:"((?:\\.|[^"\\])*)"|([^\s"]+))/gi,
    (match, key, quoted, unquoted) => {
      attributes[key.toLowerCase()] ??= quoted ?? unquoted;
      return ' ';
    });
  const disposition = /(?:^|\s)(Allow|Deny)\s+([^\r\n]+)/i.exec(bare);
  const explicitAction = disposition?.[1] ?? attributes.disp ?? attributes.action;
  const action = /^(allow|deny)$/i.test(explicitAction ?? '') ? explicitAction.toLowerCase() : null;
  const tail = disposition?.[2] ?? '';
  const fields = tail.trim().split(/\s+/);
  let positionalSource;
  let positionalDestination;
  let positionalPort;
  let positionalProtocol;

  if (address(fields[0]) && address(fields[1])) {
    // Traffic Monitor: action, source, destination, service/protocol, ports.
    [positionalSource, positionalDestination, positionalProtocol] = fields;
    positionalPort = 3;
  } else if (protocolName(fields[2]) && address(fields[3]) && address(fields[4])) {
    // Native syslog, including proxy and connection-close records.
    [, , positionalProtocol, positionalSource, positionalDestination] = fields;
    positionalPort = 5;
  } else if (/^\d+$/.test(fields[2] ?? '') && protocolName(fields[3]) && /^\d+$/.test(fields[4] ?? '')) {
    // Classic packet-filter syslog, with an optional TTL before the addresses.
    const start = /^\d+$/.test(fields[5] ?? '') ? 6 : 5;
    positionalProtocol = fields[3];
    [positionalSource, positionalDestination] = fields.slice(start, start + 2);
    positionalPort = start + 2;
  }
  const srcIp = address(attributes.src_ip) ?? address(positionalSource);
  const dstIp = address(attributes.dst_ip) ?? address(positionalDestination);
  if (!action || !srcIp || !dstIp) return null;

  const protocol = protocolName(attributes.protocol ?? attributes.proto ?? attributes.pr) ?? protocolName(positionalProtocol);
  const hasPorts = ['tcp', 'udp', 'sctp'].includes(protocol);
  const portAt = index => hasPorts && positionalPort !== undefined ? integer(fields[positionalPort + index], 65535) : null;
  const policy = /(?:^|\s)\(([^()\r\n]{1,200})\)\s*$/.exec(tail)?.[1];
  return {
    action, srcIp, dstIp, protocol,
    srcPort: integer(attributes.src_port, 65535) ?? portAt(0),
    dstPort: integer(attributes.dst_port, 65535) ?? portAt(1),
    policy: clean(attributes.policy ?? policy),
    application: clean(attributes.app_name, 120),
    host: clean(attributes.sni ?? attributes.hostname, 253)?.toLowerCase() ?? null,
    sentBytes: integer(attributes.sent_bytes),
    receivedBytes: integer(attributes.rcvd_bytes),
    messageId: clean(attributes.msg_id, 32),
  };
}
