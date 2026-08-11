import { Module } from '@nestjs/common';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { DailyRollupService } from './rollup/daily-rollup.service';

/**
 * Reporting (§17 phase 6).
 *
 * The nightly rollup that §11.2 leans on, and the read side that consumes it.
 */
@Module({
  controllers: [ReportsController],
  providers: [DailyRollupService, ReportsService],
  exports: [DailyRollupService, ReportsService],
})
export class ReportingModule {}
