import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { concatMap, type Observable } from 'rxjs';
import { MenuCacheService } from './menu-cache.service';

/**
 * Invalidates the cached menu after any successful catalog write (§10).
 *
 * An interceptor rather than a `bump()` call at the end of each service method:
 * there are a dozen write paths across four controllers, every one of them can
 * change what `GET /menu` returns, and "remember to invalidate" is exactly the
 * kind of rule that holds until someone adds the thirteenth. Attached to the
 * controller, it covers routes that do not exist yet.
 *
 * `concatMap`, not `tap`: the bump has to finish before the response goes out.
 * A kiosk that reads the 201 and immediately re-polls the menu would otherwise
 * race the invalidation and cache the document it just made stale.
 *
 * Only successful responses reach here — an error skips the value stream
 * entirely, so a rejected write leaves the version alone.
 */
@Injectable()
export class CatalogWriteInterceptor implements NestInterceptor {
  constructor(private readonly cache: MenuCacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { method } = context.switchToHttp().getRequest<{ method: string }>();
    if (method === 'GET') return next.handle();

    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.cache.bump();
        return body;
      }),
    );
  }
}
