import { generateKeyPairSync } from 'node:crypto';
import { clubForHost, parseClubs, toPublic } from './clubs';

const jwk = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });

const entry = {
  apiJwtKey: jwk(),
  dbSigningKey: { ...jwk(), kid: 'db-key-1' },
  code: 'ohouse',
  name: { en: 'O House', ar: 'أو هاوس' },
  supabaseUrl: 'https://ref.supabase.co/',
  publishableKey: 'sb_publishable_x',
  secretKey: 'sb_secret_TOP',
  gatewayKey: 'gate_TOP',
  bucket: 'checklist-media',
};

describe('parseClubs', () => {
  it('parses a club, uppercasing its code and trimming the URL', () => {
    const c = parseClubs(JSON.stringify({ ohouse: entry })).get('ohouse')!;
    expect(c.code).toBe('OHOUSE');
    expect(c.supabaseUrl).toBe('https://ref.supabase.co');
  });

  it('names the missing field without printing any secret', () => {
    const bad = { ...entry, secretKey: '' };
    expect(() => parseClubs(JSON.stringify({ ohouse: bad }))).toThrow('CLUBS.ohouse.secretKey is missing');
    try {
      parseClubs(JSON.stringify({ ohouse: { ...entry, bucket: '' } }));
    } catch (e) {
      expect(String(e)).not.toContain('TOP');
    }
  });

  it('refuses two clubs with the same code, a bad slug, or nothing at all', () => {
    expect(() => parseClubs(JSON.stringify({ a: entry, b: entry }))).toThrow('used by another club');
    expect(() => parseClubs(JSON.stringify({ 'O House': entry }))).toThrow('slug');
    expect(() => parseClubs(undefined)).toThrow('CLUBS is not set');
    expect(() => parseClubs('{')).toThrow('not valid JSON');
  });

  it('the public view carries no secret', () => {
    const pub = JSON.stringify(toPublic(parseClubs(JSON.stringify({ ohouse: entry })).get('ohouse')!));
    expect(pub).not.toContain('TOP');
    expect(pub).not.toContain(entry.apiJwtKey.d as string);
    expect(pub).not.toContain(entry.dbSigningKey.d as string);
  });

  it('needs both signing keys, the database one with its kid, and never prints them', () => {
    const noKid = { ...entry, dbSigningKey: { ...entry.dbSigningKey, kid: undefined } };
    expect(() => parseClubs(JSON.stringify({ ohouse: noKid }))).toThrow('CLUBS.ohouse.dbSigningKey must be a private EC P-256 JWK with a kid');
    const publicOnly = { ...entry, apiJwtKey: { ...entry.apiJwtKey, d: undefined } };
    expect(() => parseClubs(JSON.stringify({ ohouse: publicOnly }))).toThrow('CLUBS.ohouse.apiJwtKey');
    try {
      parseClubs(JSON.stringify({ ohouse: publicOnly }));
    } catch (e) {
      expect(String(e)).not.toContain(entry.apiJwtKey.x as string);
    }
  });
});

describe('parseClubs: fcmServiceAccount', () => {
  const sa = {
    type: 'service_account',
    project_id: 'o-house-test',
    client_email: 'firebase-adminsdk@o-house-test.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nTOPSECRET\n-----END PRIVATE KEY-----\n',
  };

  it('is optional: a club without one has no push', () => {
    expect(parseClubs(JSON.stringify({ ohouse: entry })).get('ohouse')!.fcmServiceAccount).toBeNull();
  });

  it('keeps the three fields cert() needs', () => {
    const c = parseClubs(JSON.stringify({ ohouse: { ...entry, fcmServiceAccount: sa } })).get('ohouse')!;
    expect(c.fcmServiceAccount).toEqual({ projectId: 'o-house-test', clientEmail: sa.client_email, privateKey: sa.private_key });
  });

  it('refuses a malformed key, naming the field and never printing it', () => {
    const bad = { ...sa, type: 'authorized_user' };
    expect(() => parseClubs(JSON.stringify({ ohouse: { ...entry, fcmServiceAccount: bad } }))).toThrow(
      'CLUBS.ohouse.fcmServiceAccount must be a Firebase service-account JSON',
    );
    try {
      parseClubs(JSON.stringify({ ohouse: { ...entry, fcmServiceAccount: { ...sa, client_email: '' } } }));
    } catch (e) {
      expect(String(e)).not.toContain('TOPSECRET');
    }
  });

  it('the public view carries no Firebase key', () => {
    const c = parseClubs(JSON.stringify({ ohouse: { ...entry, fcmServiceAccount: sa } })).get('ohouse')!;
    expect(JSON.stringify(toPublic(c))).not.toContain('TOPSECRET');
  });
});

describe('clubForHost', () => {
  const clubs = [...parseClubs(JSON.stringify({ ohouse: entry, clubb: { ...entry, code: 'B', hosts: ['portal.clubb.com'] } })).values()];

  it('maps <slug>.<portal domain> to its club, ignoring case, port and a trailing dot', () => {
    expect(clubForHost(clubs, 'ohouse.rounds.app', 'rounds.app')?.slug).toBe('ohouse');
    expect(clubForHost(clubs, 'OHOUSE.Rounds.App:443', 'rounds.app')?.slug).toBe('ohouse');
    expect(clubForHost(clubs, 'ohouse.rounds.app.', 'rounds.app')?.slug).toBe('ohouse');
  });

  it("maps a club's own domain", () => {
    expect(clubForHost(clubs, 'portal.clubb.com', 'rounds.app')?.slug).toBe('clubb');
  });

  it('refuses anything not configured', () => {
    expect(clubForHost(clubs, 'nope.rounds.app', 'rounds.app')).toBeUndefined();
    expect(clubForHost(clubs, 'ohouse.evil.com', 'rounds.app')).toBeUndefined(); // wrong domain
    expect(clubForHost(clubs, 'x.ohouse.rounds.app', 'rounds.app')).toBeUndefined(); // no nesting
    expect(clubForHost(clubs, 'ohouse.rounds.app', undefined)).toBeUndefined(); // no PORTAL_DOMAIN set
  });
});
