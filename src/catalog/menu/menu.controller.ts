import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Roles } from '../../identity/decorators/roles.decorator';
import { MenuService, etagFor } from './menu.service';

/**
 * `no-cache` is "revalidate before reusing", not "do not store" — which is
 * exactly the polling contract FR-3 needs: a kiosk keeps its copy and asks
 * every 10 seconds whether it is still current, and the answer is almost always
 * a 304 costing one Redis read. A `max-age` would let a tablet skip asking, and
 * stack its own staleness on top of the poll interval, putting the 10-second
 * budget out of reach.
 *
 * `private` because the route is authenticated; a shared proxy has no business
 * holding this.
 */
const CACHE_CONTROL = 'private, no-cache';

/** True if the client already holds this exact representation (RFC 9110 §13.1.2). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim() === etag);
}

/**
 * The composite menu (FR-4, §5.2) — every kiosk's one read, and the phase's
 * exit criterion.
 *
 * Takes the response object outright rather than returning a value: the cached
 * document is already JSON, and handing it to the framework to be parsed and
 * re-serialized would undo the reason it was cached.
 */
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA', 'KIOSK')
  @Get()
  async get(@Req() request: Request, @Res() response: Response): Promise<void> {
    response.setHeader('Cache-Control', CACHE_CONTROL);

    // Null means Redis is unreachable. The menu is still served, built fresh
    // from Postgres and without an ETag. `no-cache` above does not stop a
    // client storing that response — it stops it *reusing* one without
    // revalidating — and with no validator to revalidate against, every
    // revalidation is a full re-download. So nobody can serve a document we
    // have lost the ability to invalidate; while Redis is down the cost is
    // bandwidth, not staleness.
    const version = await this.menu.currentVersion();

    if (version !== null) {
      const etag = etagFor(version);
      response.setHeader('ETag', etag);

      if (matchesEtag(request.headers['if-none-match'], etag)) {
        // The whole point of the polling design: no database, no document, no
        // body — four kiosks asking every 10 seconds cost one Redis read each.
        response.status(304).end();
        return;
      }
    }

    response.type('application/json').send(await this.menu.document(version));
  }
}
