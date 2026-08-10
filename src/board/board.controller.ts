import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../identity/decorators/public.decorator';
import { BoardService, type BoardEntry } from './board.service';

/**
 * The public status board (§5.2).
 *
 * The only unauthenticated read in the system, which is why the shape is
 * decided in `BoardService` rather than here: what a route *returns* is easy to
 * review, but what a query *selects* is what actually leaves the database, and
 * for this audience those must be the same thing.
 *
 * Left on the default rate limit rather than given its own. §10.2's backstop
 * fails open, and that is right for this route for the reason the menu gives:
 * a screen above the counter going blank during a Redis outage is a visibly
 * broken shop, and the abuse budget an anonymous reader could burn here buys
 * them a list of queue numbers they can already read off the wall.
 */
@Controller('orders/board')
export class BoardController {
  constructor(private readonly board: BoardService) {}

  @Public()
  @Header('Cache-Control', 'no-store')
  @Get()
  snapshot(): Promise<BoardEntry[]> {
    return this.board.snapshot();
  }
}
