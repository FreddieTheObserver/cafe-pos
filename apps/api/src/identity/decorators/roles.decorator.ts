import { SetMetadata } from '@nestjs/common';
import type { PrincipalRole } from '../principal';

export const ROLES_KEY = 'identity:roles';

/**
 * Declares which principal roles may call a route — the §6.4 matrix expressed
 * in code, one row at a time. Typed to `PrincipalRole`, so a typo or an
 * invented role fails the build instead of silently matching nothing.
 */
export const Roles = (...roles: PrincipalRole[]) =>
  SetMetadata(ROLES_KEY, roles);
