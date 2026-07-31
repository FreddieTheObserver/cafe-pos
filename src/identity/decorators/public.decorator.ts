import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'identity:isPublic';

/**
 * Marks a route as reachable with no credentials — login, refresh, device
 * activation, the public board (§5.2).
 *
 * Its presence is what makes "no policy declared" an error rather than a
 * default: an endpoint is either explicitly public or explicitly role-gated,
 * and there is no third state a forgotten decorator can fall into.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
