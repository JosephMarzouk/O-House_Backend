import { clubForHost, parseClubs, toPublic } from './clubs';

const entry = {
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
