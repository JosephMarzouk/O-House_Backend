/**
 * The club registry. Every club is its own Supabase project, and nothing here
 * assumes where that project lives (a club's own account or the company
 * organisation): each entry carries its own URL and keys.
 *
 * ponytail: one JSON secret (CLUBS) in Railway. Move to a small control
 * database once clubs are added without a redeploy, or past about 10 clubs.
 */
export interface Club {
  slug: string;
  /** What staff type into the app on first launch. */
  code: string;
  name: { en: string; ar: string };
  logoUrl: string | null;
  supabaseUrl: string;
  publishableKey: string;
  /** Reachable only through MediaModule (later also notifications and admin). */
  secretKey: string;
  gatewayKey: string;
  bucket: string;
  /** Extra portal hosts, e.g. a club's own domain. <slug>.<PORTAL_DOMAIN> always works. */
  hosts: string[];
}

/** The fields safe to hand to an unauthenticated phone or browser. */
export type PublicClub = Pick<Club, 'slug' | 'code' | 'name' | 'logoUrl' | 'supabaseUrl' | 'publishableKey'>;

const REQUIRED = ['code', 'supabaseUrl', 'publishableKey', 'secretKey', 'gatewayKey', 'bucket'] as const;

/**
 * Throws at boot, naming the club and field but never printing a value, so a
 * misconfigured deploy fails its health check instead of serving half a club.
 */
export function parseClubs(raw: string | undefined): Map<string, Club> {
  if (!raw) throw new Error('CLUBS is not set');
  let parsed: Record<string, Partial<Club>>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CLUBS is not valid JSON');
  }

  const clubs = new Map<string, Club>();
  const codes = new Set<string>();
  for (const [slug, c] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`CLUBS: slug "${slug}" must be lowercase letters, digits or dashes`);
    for (const field of REQUIRED) {
      if (typeof c[field] !== 'string' || !c[field]) throw new Error(`CLUBS.${slug}.${field} is missing`);
    }
    const code = c.code!.toUpperCase();
    if (codes.has(code)) throw new Error(`CLUBS: code of "${slug}" is used by another club`);
    codes.add(code);
    clubs.set(slug, {
      slug,
      code,
      name: { en: c.name?.en ?? slug, ar: c.name?.ar ?? c.name?.en ?? slug },
      logoUrl: c.logoUrl ?? null,
      supabaseUrl: c.supabaseUrl!.replace(/\/+$/, ''),
      publishableKey: c.publishableKey!,
      secretKey: c.secretKey!,
      gatewayKey: c.gatewayKey!,
      bucket: c.bucket!,
      hosts: Array.isArray(c.hosts) ? c.hosts.map((h) => String(h).toLowerCase()) : [],
    });
  }
  if (clubs.size === 0) throw new Error('CLUBS has no clubs');
  return clubs;
}

/**
 * Which club a portal host belongs to: a listed custom domain first, then
 * <slug>.<portalDomain>. Anything else is no club — a host pointed at the
 * portal that we did not configure must not borrow a club's login page.
 */
export function clubForHost(clubs: Iterable<Club>, host: string, portalDomain: string | undefined): Club | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const all = [...clubs];
  const custom = all.find((c) => c.hosts.includes(h));
  if (custom) return custom;
  if (!portalDomain) return undefined;
  const suffix = `.${portalDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return undefined;
  const slug = h.slice(0, -suffix.length);
  return all.find((c) => c.slug === slug);
}

export function toPublic(c: Club): PublicClub {
  const { slug, code, name, logoUrl, supabaseUrl, publishableKey } = c;
  return { slug, code, name, logoUrl, supabaseUrl, publishableKey };
}
