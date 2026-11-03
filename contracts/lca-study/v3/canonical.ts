/** Reporting identities use only safe integers and decimal strings, never floating JSON numbers. */
export function canonicalJson(value: unknown): string {
  let remaining = 100_000;
  const encode = (item: unknown, depth: number): string => {
    if (--remaining < 0 || depth > 64) throw new Error('report_canonical_bounds');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (item.length > 4 * 1024 * 1024) throw new Error('report_canonical_bounds');
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('report_unicode_invalid');
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('report_unicode_invalid');
      }
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0))
        throw new Error('report_integer_required');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    if (
      item &&
      typeof item === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    ) {
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${encode(key, depth + 1)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(',')}}`;
    }
    throw new Error('report_json_required');
  };
  const result = encode(value, 0);
  if (new TextEncoder().encode(result).length > 4 * 1024 * 1024)
    throw new Error('report_canonical_bounds');
  return result;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function parseCanonicalBytes(bytes: Uint8Array): unknown {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('report_canonical_bounds');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  // This rejects duplicate keys, alternate whitespace/escapes and all parser ambiguity.
  if (canonicalJson(value) !== text) throw new Error('report_noncanonical_bytes');
  return value;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}

export function domainBytes(domain: string, value: unknown): Uint8Array {
  return new TextEncoder().encode(`${domain}\0${canonicalJson(value)}`);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(text: string, expectedBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(text) || text.length > Math.ceil((expectedBytes * 4) / 3))
    throw new Error('report_base64_invalid');
  const decoded = Uint8Array.from(
    atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
  if (decoded.length !== expectedBytes || base64Url(decoded) !== text)
    throw new Error('report_base64_invalid');
  return decoded;
}
