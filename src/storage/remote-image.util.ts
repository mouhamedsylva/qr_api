import { isIP } from 'node:net';

/**
 * Liens de partage courants → lien direct vers le fichier.
 * - Google Drive : /file/d/<id>/view, open?id=<id>, uc?id=<id>
 * - Dropbox : ?dl=0 → ?raw=1
 */
export function directImageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  const host = url.hostname.toLowerCase();

  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id =
      /\/file\/d\/([\w-]{10,})/.exec(url.pathname)?.[1] ??
      url.searchParams.get('id');
    if (id) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
    }
  }

  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  }

  return url.toString();
}

/** IPv4 → entier non signé, ou null si invalide. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  return (
    ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  );
}

const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // « ce réseau »
  ['10.0.0.0', 8], // privé
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // bouclage
  ['169.254.0.0', 16], // link-local (métadonnées cloud)
  ['172.16.0.0', 12], // privé
  ['192.0.0.0', 24], // réservé IETF
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // privé
  ['198.18.0.0', 15], // tests
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // réservé, diffusion
];

function inIpv4Range(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

/**
 * Adresse interdite pour un téléchargement côté serveur (protection SSRF) :
 * réseaux privés, bouclage, link-local, réservés — en IPv4 comme en IPv6.
 */
export function isForbiddenIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return (
      n === null ||
      IPV4_BLOCKED.some(([base, bits]) => inIpv4Range(n, base, bits))
    );
  }
  if (family === 6) {
    const v6 = ip.toLowerCase();
    // IPv4 encapsulée (::ffff:a.b.c.d) : même règle qu'en IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
    if (mapped) return isForbiddenIp(mapped);
    return (
      v6 === '::' ||
      v6 === '::1' ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') || // ULA privées
      /^fe[89ab]/.test(v6) || // link-local
      v6.startsWith('ff') // multicast
    );
  }
  return true; // pas une adresse IP : refusé par prudence
}
