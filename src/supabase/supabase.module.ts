import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClubsService } from '../clubs/clubs.module';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Club } from '../clubs/clubs';

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/**
 * Publishable-key clients only. The secret key is deliberately not reachable
 * from here: it lives in MediaModule's own provider (see media.module.ts).
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  // Keyed by club slug on purpose: a client is never shared across clubs.
  private readonly authClients = new Map<string, SupabaseClient>();

  constructor(private readonly clubs: ClubsService) {}

  /**
   * Build every club's client at boot. supabase-js throws on construction
   * when the runtime can't support it (Node < 22 has no global WebSocket),
   * and that must fail the deploy's health check, not the first real request.
   */
  onModuleInit(): void {
    for (const club of this.clubs.all()) this.authClient(club);
  }

  /** For verifying tokens (getClaims keeps the club's JWKS cached). */
  authClient(club: Club): SupabaseClient {
    let c = this.authClients.get(club.slug);
    if (!c) {
      c = createClient(club.supabaseUrl, club.publishableKey, { auth: NO_SESSION });
      this.authClients.set(club.slug, c);
    }
    return c;
  }

  /**
   * Queries Postgres AS the user: every RLS policy and RPC guard applies
   * exactly as it does for the phone today. The gateway key lets the request
   * through the Data API gate once it is switched on (plan Step 4).
   */
  forUser(club: Club, jwt: string): SupabaseClient {
    return createClient(club.supabaseUrl, club.publishableKey, {
      global: { headers: { Authorization: `Bearer ${jwt}`, 'x-ohouse-gateway-key': club.gatewayKey } },
      auth: NO_SESSION,
    });
  }
}

@Global()
@Module({ providers: [SupabaseService], exports: [SupabaseService] })
export class SupabaseModule {}
