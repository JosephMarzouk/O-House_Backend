import { Injectable, Module } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Club } from '../clubs/clubs';
import { UpstreamError } from '../common/upstream';

export const SIGNED_URL_TTL_S = 3600;

/**
 * The secret key's only home in Step 1. It is a provider of this module and
 * not exported, so nothing outside media/ can inject it. Notifications and
 * admin get their own when they arrive (plan Steps 5 and 7).
 */
@Injectable()
class SystemClients {
  private readonly clients = new Map<string, SupabaseClient>();

  for(club: Club): SupabaseClient {
    let c = this.clients.get(club.slug);
    if (!c) {
      c = createClient(club.supabaseUrl, club.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      this.clients.set(club.slug, c);
    }
    return c;
  }
}

/**
 * A stored media value as a bucket path, or null when it can't be signed.
 *
 * Three shapes reach us: a bare path (what the app and submit_assignment
 * write), a full public URL (the legacy web client stored those in
 * signature_url), and a local device path the phone never uploaded.
 */
export function toBucketPath(value: string | null | undefined, bucket: string): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    const marker = `/storage/v1/object/public/${bucket}/`;
    const at = value.indexOf(marker);
    return at < 0 ? null : decodeURIComponent(value.slice(at + marker.length).split('?')[0]);
  }
  if (/^([a-z]:[\\/]|\/(data|storage|var|private|Users)\/)/i.test(value)) return null; // device path
  return value.replace(/^\/+/, '');
}

@Injectable()
export class MediaService {
  constructor(private readonly system: SystemClients) {}

  /**
   * Signs paths with the secret key. Callers MUST only pass paths taken from
   * rows they just read as the user: the RLS read is the authorization, and
   * this does no check of its own.
   */
  async sign(club: Club, paths: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return {};
    const { data, error } = await this.system
      .for(club)
      .storage.from(club.bucket)
      .createSignedUrls(unique, SIGNED_URL_TTL_S);
    if (error) throw new UpstreamError(error.message);
    const out: Record<string, string> = {};
    for (const s of data) if (s.path && s.signedUrl && !s.error) out[s.path] = s.signedUrl;
    return out; // a missing object is simply absent: the client shows its placeholder
  }
}

@Module({ providers: [SystemClients, MediaService], exports: [MediaService] })
export class MediaModule {}
