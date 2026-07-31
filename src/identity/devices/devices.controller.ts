import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentPrincipal } from '../decorators/current-principal.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { StaffPrincipal } from '../principal';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limits';
import {
  ActivateDeviceDto,
  CreateDeviceDto,
  DeviceIdParamDto,
  UpdateDeviceDto,
} from './devices.dto';
import {
  DevicesService,
  type ActivatedDevice,
  type CreatedDevice,
  type DeviceSummary,
} from './devices.service';

/**
 * Kiosk devices (§5.2, §6.4). Managers and admins run the fleet; the one route
 * a kiosk itself may call is activation, and it is gated by the pairing code
 * rather than by a role — the tablet has no credential until it succeeds.
 */
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(
    @Body() body: CreateDeviceDto,
    @CurrentPrincipal() principal: StaffPrincipal,
  ): Promise<CreatedDevice> {
    return this.devices.create(body, principal.userId);
  }

  /**
   * §5.2: public, code-gated, and 200 rather than 201 — the device row already
   * exists; this exchanges a code for a credential.
   */
  @Public()
  @RateLimit(RATE_LIMITS.deviceActivation)
  @HttpCode(200)
  @Post('activate')
  activate(@Body() body: ActivateDeviceDto): Promise<ActivatedDevice> {
    return this.devices.activate(body.pairingCode);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<DeviceSummary[]> {
    return this.devices.list();
  }

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: DeviceIdParamDto,
    @Body() body: UpdateDeviceDto,
  ): Promise<DeviceSummary> {
    return this.devices.update(params.id, body);
  }

  /** The stolen-tablet path (§6.2): 204, and safe to call twice. */
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(204)
  @Post(':id/revoke')
  revoke(@Param() params: DeviceIdParamDto): Promise<void> {
    return this.devices.revoke(params.id);
  }
}
