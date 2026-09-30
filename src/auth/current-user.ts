import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Club } from '../clubs/clubs';

/**
 * Every column except `phone`. Migration 0011's intent is that phone is
 * admin-only, and once it is enforced again a select including it fails, so
 * the API never asks for it (same list as the portal's PROFILE_COLUMNS).
 */
export const PROFILE_COLUMNS =
  'id, name, email, role, role_id, created_at, department_id, manager_id, active, must_change_password, locale';

export interface Profile {
  id: string;
  name: string | null;
  email: string | null;
  /** Text mirror of the role, kept by a trigger (custom roles mirror as 'cleaner'). role_id is the truth. */
  role: string | null;
  role_id: string | null;
  created_at: string;
  department_id: string | null;
  manager_id: string | null;
  active: boolean | null;
  must_change_password: boolean | null;
  locale: string | null;
}

export interface CurrentUser {
  id: string;
  jwt: string;
  club: Club;
  profile: Profile;
}

export const User = createParamDecorator((_: unknown, ctx: ExecutionContext): CurrentUser => {
  return ctx.switchToHttp().getRequest().user;
});
