import { Module } from '@nestjs/common';
import { DailyRollupService } from './rollup/daily-rollup.service';

/**
 * Reporting (§17 phase 6).
 *
 * Producer only for now — the nightly rollup that §11.2 leans on. The
 * `/reports/*` read side lands in the next slice and joins this module.
 */
@Module({
  providers: [DailyRollupService],
  exports: [DailyRollupService],
})
export class ReportingModule {}
