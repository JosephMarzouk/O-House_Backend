import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Global,
  HttpCode,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ClubsService } from '../clubs/clubs.module';
import type { Club } from '../clubs/clubs';
import { must, UpstreamError } from '../common/upstream';
import { isUuid } from '../common/errors.filter';
import { SupabaseService } from '../supabase/supabase.module';
import { Public } from './public.decorator';
import { CurrentUser, User } from './current-user';
import { ACCESS_TTL_S, DB_TTL_S, newRefreshToken, REFRESH_TTL_MS, sha256, TokenService } from './tokens';
import {
  afterFailure,
  BCRYPT_COST,
  isLocked,
  MIN_PASSWORD,
  parseLogin,
  refreshVerdict,
} from './logins';

type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; userId: string };

const bad = (code: string, message: string) => new BadRequestException({ code, message });
const invalidLogin = () => new UnauthorizedException({ code: 'INVALID_LOGIN', message: 'Wrong phone, email or password' });
const signInAgain = () => new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Sign in again' });

/**
 * The secret key's home for sign-in (plan: the fourth module allowed it, with
 * media, notifications and admin). user_logins and refresh_tokens are closed
 * to every client role, so only this reaches them.
 */
@Injectable()
export class LoginsService {
  private readonly clients = new Map<string, SupabaseClient>();
  // A real bcrypt hash of random bytes nobody knows, made once at boot. An
  // unknown login is compared against it, so "no such account" and "wrong
  // password" cost the same time and cannot be told apart.
  private readonly dummyHash = bcrypt.hashSync(randomBytes(24).toString('base64'), BCRYPT_COST);

  constructor(
    private readonly tokens: TokenService,
    private readonly supabase: SupabaseService,
  ) {}

  private db(club: Club): SupabaseClient {
    let c = this.clients.get(club.slug);
    if (!c) {
      c = createClient(club.supabaseUrl, club.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      this.clients.set(club.slug, c);
    }
    return c;
  }

  private async one<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
    const { data, error } = await q;
    if (error) throw new UpstreamError(error.message);
    return data;
  }

  /** Active, with a role: the same bar the guard sets on every request. */
  private async mayUse(club: Club, userId: string): Promise<boolean> {
    const p = await this.one<{ role_id: string | null; active: boolean | null }>(
      this.db(club).from('profiles').select('role_id, active').eq('id', userId).maybeSingle(),
    );
    return !!p?.role_id && p.active !== false;
  }

  /**
   * The rail for the secret-key writes below (they bypass RLS): ask the
   * database AS the caller whether their role may do this. Only an explicit
   * true passes.
   */
  private async allowed(caller: CurrentUser, fn: 'can_assign_role' | 'can_manage_user', args: Record<string, unknown>) {
    return must(await this.supabase.forUser(caller.club, caller.jwt).rpc(fn, args)) === true;
  }

  private async issue(club: Club, userId: string, family: string): Promise<Tokens> {
    const refreshToken = newRefreshToken();
    await this.one(
      this.db(club).from('refresh_tokens').insert({
        user_id: userId,
        token_sha256: sha256(refreshToken),
        family,
        expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
      }),
    );
    return { accessToken: this.tokens.accessToken(club, userId), refreshToken, expiresIn: ACCESS_TTL_S, userId };
  }

  async login(club: Club, typed: unknown, password: unknown): Promise<Tokens> {
    if (typeof password !== 'string' || password.length === 0 || password.length > 200) throw invalidLogin();
    const key = parseLogin(typed);
    const row = key
      ? await this.one<{ user_id: string; password_hash: string; failed_count: number; locked_until: string | null }>(
          this.db(club)
            .from('user_logins')
            .select('user_id, password_hash, failed_count, locked_until')
            .eq('phone' in key ? 'phone' : 'email', 'phone' in key ? key.phone : key.email)
            .maybeSingle(),
        )
      : null;

    if (row && isLocked(row.locked_until)) {
      throw new HttpException({ code: 'LOGIN_LOCKED', message: 'Too many wrong passwords. Try again in 15 minutes' }, 429);
    }
    const ok = await bcrypt.compare(password, row?.password_hash ?? this.dummyHash);
    if (!row || !ok) {
      if (row) {
        await this.one(this.db(club).from('user_logins').update(afterFailure(row.failed_count)).eq('user_id', row.user_id));
      }
      throw invalidLogin();
    }
    if (!(await this.mayUse(club, row.user_id))) {
      throw new ForbiddenException({ code: 'NO_ACCESS', message: 'This account has no access' });
    }
    if (row.failed_count > 0 || row.locked_until) {
      await this.one(
        this.db(club).from('user_logins').update({ failed_count: 0, locked_until: null }).eq('user_id', row.user_id),
      );
    }
    return this.issue(club, row.user_id, randomUUID());
  }

  async refresh(club: Club, presented: unknown): Promise<Tokens> {
    if (typeof presented !== 'string' || presented.length > 100) throw signInAgain();
    const row = await this.one<{
      id: string;
      user_id: string;
      family: string;
      expires_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
    }>(
      this.db(club)
        .from('refresh_tokens')
        .select('id, user_id, family, expires_at, revoked_at, revoked_reason')
        .eq('token_sha256', sha256(presented))
        .maybeSingle(),
    );

    const verdict = refreshVerdict(row);
    if (verdict === 'dead') throw signInAgain();
    if (verdict === 'reuse') {
      // A token rotated away long ago came back: someone else holds the
      // family. Everyone using it signs in again.
      await this.one(
        this.db(club)
          .from('refresh_tokens')
          .update({ revoked_at: new Date().toISOString(), revoked_reason: 'reuse' })
          .eq('family', row!.family)
          .is('revoked_at', null),
      );
      throw signInAgain();
    }
    if (!(await this.mayUse(club, row!.user_id))) throw signInAgain();

    if (verdict === 'ok') {
      await this.one(
        this.db(club)
          .from('refresh_tokens')
          .update({ revoked_at: new Date().toISOString(), revoked_reason: 'rotated' })
          .eq('id', row!.id)
          .is('revoked_at', null),
      );
    }
    return this.issue(club, row!.user_id, row!.family);
  }

  async logout(club: Club, presented: unknown): Promise<void> {
    if (typeof presented !== 'string' || presented.length > 100) return;
    await this.one(
      this.db(club)
        .from('refresh_tokens')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'logout' })
        .eq('token_sha256', sha256(presented))
        .is('revoked_at', null),
    );
  }

  // ---- staff administration (was the portal's service-role code) ----------

  async createStaff(
    club: Club,
    caller: CurrentUser,
    body: {
      name?: unknown;
      phone?: unknown;
      email?: unknown;
      password?: unknown;
      roleId?: unknown;
      departmentId?: unknown;
    },
  ): Promise<{ id: string }> {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw bad('FIELDS_REQUIRED', 'Name is required');
    if (!isUuid(body.roleId)) throw bad('ROLE_REQUIRED', 'Choose a role');
    const roleId = body.roleId;
    if (body.departmentId != null && !isUuid(body.departmentId)) throw bad('DEPARTMENT_INVALID', 'Not a department');
    const departmentId = (body.departmentId as string | null | undefined) ?? null;
    // The insert below uses the secret key (no RLS), so this is the only rail.
    if (!(await this.allowed(caller, 'can_assign_role', { p_role_id: roleId, p_department_id: departmentId }))) {
      throw new ForbiddenException({ code: 'ROLE_NOT_ALLOWED', message: 'You cannot give this role' });
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) throw bad('PASSWORD_TOO_SHORT', `At least ${MIN_PASSWORD} characters`);

    // Phone, email, or both — at least one is the person's sign-in name.
    const phone = typeof body.phone === 'string' && body.phone.trim() ? parseLogin(body.phone.replace(/@/g, '')) : null;
    const email = typeof body.email === 'string' && body.email.trim() ? parseLogin(body.email) : null;
    if (typeof body.phone === 'string' && body.phone.trim() && !(phone && 'phone' in phone)) throw bad('PHONE_INVALID', 'Phone must be 10 digits');
    if (typeof body.email === 'string' && body.email.trim() && !(email && 'email' in email)) throw bad('EMAIL_INVALID', 'Not an email address');
    const ph = phone && 'phone' in phone ? phone.phone : null;
    const em = email && 'email' in email ? email.email : null;
    if (!ph && !em) throw bad('FIELDS_REQUIRED', 'A phone number or an email is required');

    const db = this.db(club);
    const taken = await this.one<{ user_id: string }[]>(
      db.from('user_logins').select('user_id').or([ph && `phone.eq.${ph}`, em && `email.eq."${em}"`].filter(Boolean).join(',')),
    );
    if (taken && taken.length > 0) throw new ConflictException({ code: 'LOGIN_TAKEN', message: 'This phone or email already signs in' });

    const id = randomUUID();
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    await this.one(
      db.from('profiles').insert({
        id,
        name,
        email: em ?? '',
        phone: ph,
        role_id: roleId,
        department_id: departmentId,
        must_change_password: false,
      }),
    );
    const { error } = await db.from('user_logins').insert({ user_id: id, phone: ph, email: em, password_hash: hash });
    if (error) {
      // No half-made account: the profile goes if its sign-in could not be made.
      await db.from('profiles').delete().eq('id', id);
      if (/duplicate key|23505/.test(error.message)) {
        throw new ConflictException({ code: 'LOGIN_TAKEN', message: 'This phone or email already signs in' });
      }
      throw new UpstreamError(error.message);
    }
    return { id };
  }

  /**
   * Someone with the users.edit permission sets a person's password (staff
   * never change their own — business rule). can_manage_user says whether
   * this person is in the caller's reach and holds a role the caller could
   * create: resetting a peer's password is a silent account takeover. Every
   * session the person had is ended.
   */
  async resetPassword(club: Club, caller: CurrentUser, targetId: string, password: unknown): Promise<void> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw bad('PASSWORD_TOO_SHORT', `At least ${MIN_PASSWORD} characters`);
    }
    const db = this.db(club);
    // One answer for "no such user" and "not yours to reset": no id oracle.
    if (!(await this.allowed(caller, 'can_manage_user', { p_user_id: targetId }))) {
      throw new ForbiddenException({ code: 'NOT_AUTHORIZED', message: 'Not authorized' });
    }
    const updated = await this.one<{ user_id: string }[]>(
      db
        .from('user_logins')
        .update({
          password_hash: await bcrypt.hash(password, BCRYPT_COST),
          password_changed_at: new Date().toISOString(),
          failed_count: 0,
          locked_until: null,
        })
        .eq('user_id', targetId)
        .select('user_id'),
    );
    if (!updated || updated.length === 0) throw new NotFoundException({ code: 'NO_LOGIN', message: 'This person has no sign-in yet' });
    await this.one(
      db
        .from('refresh_tokens')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'reset' })
        .eq('user_id', targetId)
        .is('revoked_at', null),
    );
  }
}

/** The club named by X-Club, for the public sign-in routes (the guard does this for the rest). */
function clubOf(clubs: ClubsService, req: Request): Club {
  const club = clubs.bySlug(req.header('x-club'));
  if (!club) throw new NotFoundException({ code: 'UNKNOWN_CLUB', message: 'Unknown club' });
  return club;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly logins: LoginsService,
    private readonly clubs: ClubsService,
  ) {}

  /** Tight on purpose: 10 tries a minute per IP, on top of the per-account lock. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Body() body: { login?: unknown; password?: unknown }) {
    return this.logins.login(clubOf(this.clubs, req), body?.login, body?.password);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Body('refreshToken') token: unknown) {
    return this.logins.refresh(clubOf(this.clubs, req), token);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Body('refreshToken') token: unknown) {
    await this.logins.logout(clubOf(this.clubs, req), token);
  }

  /**
   * The portal SERVER's way to query PostgREST as its signed-in user: the
   * guard has already verified the access token and minted this token. The
   * portal's own gateway key (PORTAL_GATEWAY_KEY here, OHOUSE_GATEWAY_KEY on
   * the portal) proves the caller is the portal's server — a phone or a
   * browser holding a stolen access token still cannot get one. Unset, the
   * route refuses everyone.
   */
  @Get('db-token')
  dbToken(@Req() req: Request, @User() user: CurrentUser) {
    const sent = Buffer.from(req.header('x-ohouse-portal-key') ?? '');
    const want = Buffer.from(process.env.PORTAL_GATEWAY_KEY ?? '');
    if (want.length === 0 || sent.length !== want.length || !timingSafeEqual(sent, want)) {
      throw new ForbiddenException({ code: 'GATEWAY_REQUIRED', message: 'Server callers only' });
    }
    return { token: user.jwt, expiresIn: DB_TTL_S, userId: user.id };
  }
}

@Controller('admin/staff')
export class AdminStaffController {
  constructor(private readonly logins: LoginsService) {}

  @Post()
  create(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    return this.logins.createStaff(user.club, user, body ?? {});
  }

  @Post(':id/password')
  @HttpCode(204)
  async password(
    @User() user: CurrentUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('password') password: unknown,
  ) {
    await this.logins.resetPassword(user.club, user, id, password);
  }
}

@Global()
@Module({
  providers: [TokenService, LoginsService],
  controllers: [AuthController, AdminStaffController],
  exports: [TokenService],
})
export class AuthModule {}
