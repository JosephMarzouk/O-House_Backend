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
  /** Private ES256 JWK: signs the access tokens the API hands to phones and the portal. */
  apiJwtKey: EcJwk;
  /**
   * Private ES256 JWK, with its `kid`, imported into the club's Supabase JWT
   * signing keys: signs the short-lived tokens the API sends PostgREST as the
   * user. Supabase keeps only the public half's trust; this is the only copy.
   */
  dbSigningKey: EcJwk;
  /**
   * The club's Firebase service-account key (the JSON file Firebase calls a
   * "private key", pasted whole). Each club's staff app has its own Firebase
   * project, and a phone's token only takes messages signed by that project,
   * so one club's key can never reach another club's staff. Absent: the club
   * has no push yet, and its notifications are recorded as skipped.
   */
  fcmServiceAccount: FcmServiceAccount | null;
  /**
   * The report emails (src/reports): the club's Microsoft 365 app
   * registration with the application permission Mail.Send, `sender` (the
   * club's default mailbox; Club settings' "Send from" overrides it) and
   * `portalUrl`, where the API fetches the report PDF: this club's own portal
   * host. Absent: no report emails.
   */
  mail: MailConfig | null;
}

export interface MailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The club's default sender; null = only Club settings' "Send from". */
  sender: string | null;
  portalUrl: string;
}

/** Throws naming the field, never printing the secret. */
function parseMail(v: unknown, where: string): MailConfig | null {
  if (v === undefined || v === null) return null;
  const m = v as Record<string, unknown>;
  const ok =
    typeof m === 'object' &&
    [m.tenantId, m.clientId, m.clientSecret, m.portalUrl].every((s) => typeof s === 'string' && s.length > 0) &&
    /^https?:\/\//.test(String(m.portalUrl)) &&
    (m.sender === undefined || m.sender === null || (typeof m.sender === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.sender)));
  if (!ok) {
    throw new Error(`${where} must have tenantId, clientId, clientSecret, portalUrl (http/https) and, optionally, sender (an address)`);
  }
  return {
    tenantId: String(m.tenantId),
    clientId: String(m.clientId),
    clientSecret: String(m.clientSecret),
    sender: m.sender ? String(m.sender).toLowerCase() : null,
    portalUrl: String(m.portalUrl).replace(/\/+$/, ''),
  };
}

/** The three fields firebase-admin's cert() needs, from a service-account JSON file. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Throws naming the field, never printing the key. */
function parseFcmServiceAccount(v: unknown, where: string): FcmServiceAccount | null {
  if (v === undefined || v === null) return null;
  const k = v as Record<string, unknown>;
  const ok =
    typeof k === 'object' &&
    k.type === 'service_account' &&
    [k.project_id, k.client_email, k.private_key].every((s) => typeof s === 'string' && s.length > 0) &&
    String(k.private_key).includes('PRIVATE KEY');
  if (!ok) throw new Error(`${where} must be a Firebase service-account JSON (type, project_id, client_email, private_key)`);
  return { projectId: String(k.project_id), clientEmail: String(k.client_email), privateKey: String(k.private_key) };
}

/** An EC P-256 private key as a JWK (`supabase gen signing-key --algorithm ES256`). */
export interface EcJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  kid?: string;
}

/** Throws naming the field, never printing the key. */
function parseEcJwk(v: unknown, where: string, needKid: boolean): EcJwk {
  const k = v as Partial<EcJwk> | undefined;
  const ok =
    !!k &&
    typeof k === 'object' &&
    k.kty === 'EC' &&
    k.crv === 'P-256' &&
    [k.x, k.y, k.d].every((s) => typeof s === 'string' && s.length > 0) &&
    (!needKid || (typeof k.kid === 'string' && k.kid.length > 0));
  if (!ok) throw new Error(`${where} must be a private EC P-256 JWK${needKid ? ' with a kid' : ''}`);
  return { kty: 'EC', crv: 'P-256', x: k!.x!, y: k!.y!, d: k!.d!, ...(k!.kid ? { kid: k!.kid } : {}) };
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
      apiJwtKey: parseEcJwk(c.apiJwtKey, `CLUBS.${slug}.apiJwtKey`, false),
      dbSigningKey: parseEcJwk(c.dbSigningKey, `CLUBS.${slug}.dbSigningKey`, true),
      fcmServiceAccount: parseFcmServiceAccount(c.fcmServiceAccount, `CLUBS.${slug}.fcmServiceAccount`),
      mail: parseMail(c.mail, `CLUBS.${slug}.mail`),
    });
  }
  // One API for every club: two clubs sharing a portal would render one
  // club's report with the other's sign-in, and two sharing a sender would
  // mail as each other. Refuse at boot rather than send the wrong thing.
  for (const field of ['portalUrl', 'sender'] as const) {
    const seen = new Map<string, string>();
    for (const c of clubs.values()) {
      const v = c.mail?.[field]?.toLowerCase();
      if (!v) continue;
      if (seen.has(v)) throw new Error(`CLUBS: ${seen.get(v)} and ${c.slug} have the same mail.${field}`);
      seen.set(v, c.slug);
    }
  }
  if (clubs.size === 0) throw new Error('CLUBS has no clubs');
  return clubs;
}

/**
 * CLUB_ALIASES: a club that borrows another club's database and keys, e.g.
 * {"ryze": {"of": "ohouse", "code": "RYZE", "name": {"en": "RYZE", "ar": "رايز"}}}.
 *
 * For the 2-week pilot (from 20 Oct 2026) RYZE and KODE run on O House's
 * database (your decision, 18 Oct): their own app and portal and brand, the
 * same data. An alias holds no secret of its own, so setting it never means
 * copying O House's keys; the slug, code and issuer are its own, so a RYZE
 * token still can't be used as O House. It gets no push and no report mail:
 * those workers would otherwise run twice over one database.
 * ponytail: remove the aliases once each club has its own Supabase project,
 * and give each a real CLUBS entry (PLAN.md "Onboarding a club").
 */
export function addAliases(clubs: Map<string, Club>, raw: string | undefined): Map<string, Club> {
  if (!raw) return clubs;
  let parsed: Record<string, { of?: unknown; code?: unknown; name?: { en?: string; ar?: string } }>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CLUB_ALIASES is not valid JSON');
  }
  const codes = new Set([...clubs.values()].map((c) => c.code));
  for (const [slug, a] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`CLUB_ALIASES: slug "${slug}" must be lowercase letters, digits or dashes`);
    if (clubs.has(slug)) throw new Error(`CLUB_ALIASES: "${slug}" is already a club`);
    const base = typeof a.of === 'string' ? clubs.get(a.of) : undefined;
    if (!base) throw new Error(`CLUB_ALIASES.${slug}.of must name a club in CLUBS`);
    if (typeof a.code !== 'string' || !a.code) throw new Error(`CLUB_ALIASES.${slug}.code is missing`);
    const code = a.code.toUpperCase();
    if (codes.has(code)) throw new Error(`CLUB_ALIASES: code of "${slug}" is used by another club`);
    codes.add(code);
    clubs.set(slug, {
      ...base,
      slug,
      code,
      name: { en: a.name?.en ?? slug, ar: a.name?.ar ?? a.name?.en ?? slug },
      logoUrl: null,
      hosts: [],
      fcmServiceAccount: null,
      mail: null,
    });
  }
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
