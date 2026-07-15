// Pure address parsing and inbound routing decisions. Inputs to the matchers
// are already-parsed lowercase address parts (see parseAddress/addressList);
// the ingest path is responsible for that normalization order.

export type ParsedAddress = {
  name: string | null;
  /** Lowercased address part. */
  address: string;
};

/**
 * Parses `Display Name <a@b.com>`, `"Quoted, Name" <a@b.com>`, or a bare
 * address. Returns null unless a plausible address is present (an `@` with
 * non-empty local and domain parts).
 */
export function parseAddress(value: string | null | undefined): ParsedAddress | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;

  let name: string | null = null;
  let address = trimmed;
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  if (angled) {
    const rawName = (angled[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
    name = rawName || null;
    address = (angled[2] ?? "").trim();
  }

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { name, address: address.toLowerCase() };
}

// Splits on commas outside double quotes so `"Doe, Jane" <j@x.com>, a@y.com`
// yields two entries, not three.
function splitAddressString(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Lowercase address parts from an array of address strings or a single
 * (possibly comma-separated) string. Invalid entries are dropped; duplicates
 * are removed preserving first occurrence.
 */
export function addressList(value: string[] | string | null | undefined): string[] {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : splitAddressString(value);
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const entry of entries) {
    const parsed = parseAddress(entry);
    if (!parsed || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    addresses.push(parsed.address);
  }
  return addresses;
}

/**
 * Decides whether inbound mail is for us and which public address to store.
 * Candidates are walked received_for first, then to, then cc — received_for
 * is authoritative under Gmail forwarding, where to/cc show the customer's
 * own mailbox. Each candidate is translated through aliasMap before matching;
 * a managed alias always counts as a match even when inboundAddresses only
 * lists public addresses. In accept-all mode (inboundAddresses null) mail
 * with zero parseable recipients still matches — it must not be dropped.
 */
export function matchInboundAddress(args: {
  to: string[];
  cc: string[];
  receivedFor: string[];
  inboundAddresses: string[] | null;
  aliasMap: Record<string, string>;
}): { matched: boolean; inboundAddress: string | null } {
  const candidates = [...args.receivedFor, ...args.to, ...args.cc];
  for (const candidate of candidates) {
    const mapped: string | undefined = args.aliasMap[candidate];
    const translated = mapped ?? candidate;
    if (
      args.inboundAddresses === null ||
      mapped !== undefined ||
      args.inboundAddresses.includes(translated)
    ) {
      return { matched: true, inboundAddress: translated };
    }
  }
  if (args.inboundAddresses === null && candidates.length === 0) {
    return { matched: true, inboundAddress: null };
  }
  return { matched: false, inboundAddress: null };
}

/**
 * True when the sender is ourselves — the config fromEmail (a display string
 * like `Support <support@x.com>`; compared by its parsed address part, never
 * the display form) or any configured inbound address. Guards against
 * auto-reply loops re-ingesting our own outbound mail.
 */
export function isLoopMail(args: {
  fromAddress: string | null;
  fromEmail: string;
  inboundAddresses: string[] | null;
}): boolean {
  if (!args.fromAddress) return false;
  const configured = parseAddress(args.fromEmail);
  if (configured && configured.address === args.fromAddress) return true;
  return args.inboundAddresses?.includes(args.fromAddress) ?? false;
}
