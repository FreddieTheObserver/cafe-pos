import { Module } from '@nestjs/common';
import { KdsController } from './kds.controller';
import { KdsService } from './kds.service';

/**
 * The kitchen display surface (§5.2, §17 Phase 5).
 *
 * Separate from `OrdersModule` because the two answer different questions about
 * the same table: Orders is the write path and the history, while this is a
 * live worklist that the realtime layer will push to. Keeping it apart means
 * the gateway can depend on the board's shape without `OrdersModule` gaining a
 * dependency on Socket.IO.
 */
@Module({
  controllers: [KdsController],
  providers: [KdsService],
  exports: [KdsService],
})
export class KdsModule {}
