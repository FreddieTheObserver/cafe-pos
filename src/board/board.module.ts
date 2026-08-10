import { Module } from '@nestjs/common';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';

/**
 * The public board (§5.2, §17 Phase 5).
 *
 * **Must be imported before `OrdersModule`.** Express matches routes in
 * registration order, and `OrdersModule` declares `GET /orders/:id` — which
 * happily matches `/orders/board` and answers 422 for a queue number that is
 * not a UUID. Registering this first is what makes the specific path win over
 * the parameterised one, and `board-http.e2e-spec.ts` pins it so a reordering
 * of the imports fails a test rather than a customer's screen.
 */
@Module({
  controllers: [BoardController],
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
