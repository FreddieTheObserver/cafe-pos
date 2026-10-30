import { Controller, Get, Header } from '@nestjs/common';
import { Roles } from '../identity/decorators/roles.decorator';
import { KdsService, type KdsTicket } from './kds.service';

/**
 * The kitchen display's snapshot endpoint (§5.2).
 *
 * BARISTA is the point of this route, and the reason the §6.4 matrix lets the
 * bar read orders at all. Cashiers and above are included because the counter
 * screen shows the same board — someone has to answer "is number 42 ready?"
 * when the customer asks at the till rather than at the bar.
 *
 * No KIOSK: a tablet in a public space has no business holding a list of what
 * the cafe is making, and §5.2 gives it the `kiosk` namespace for its own order
 * instead. `no-store` because a board cached even briefly is a board showing
 * drinks that were collected minutes ago.
 */
@Controller('kds/orders')
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Header('Cache-Control', 'no-store')
  @Get()
  snapshot(): Promise<KdsTicket[]> {
    return this.kds.snapshot();
  }
}
