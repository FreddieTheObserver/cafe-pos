import { Controller, Get, Header, Query } from '@nestjs/common';
import { Roles } from '../../identity/decorators/roles.decorator';
import { SalesQueryDto } from './reports.dto';
import { ReportsService, type SalesReport } from './reports.service';

/**
 * The §5.2 reporting reads.
 *
 * MANAGER and ADMIN only, per §6.4's matrix — the same bar as refunds. A
 * cashier can take money all day and cannot see the day's totals, which is the
 * separation the matrix exists to draw.
 *
 * Every route is `no-store`. §11.4 puts reports-for-today in the not-cached
 * column, and a stale figure in a document someone signs off is worse than a
 * slow one.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'no-store')
  @Get('sales')
  sales(@Query() query: SalesQueryDto): Promise<SalesReport> {
    return this.reports.salesReport(query);
  }
}
