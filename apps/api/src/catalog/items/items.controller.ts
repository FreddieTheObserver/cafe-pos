import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../../identity/decorators/roles.decorator';
import { ImageFileMissingError } from '../errors/catalog.errors';
import { CatalogWriteInterceptor } from '../menu/catalog-write.interceptor';
import {
  ItemImageService,
  MAX_UPLOAD_BYTES,
  type UploadedImage,
} from './item-image.service';
import { SetItemOptionGroupsDto } from './item-option-groups.dto';
import {
  ItemOptionGroupsService,
  type AttachedOptionGroup,
} from './item-option-groups.service';
import {
  CreateItemDto,
  ItemIdParamDto,
  SetItemAvailabilityDto,
  UpdateItemDto,
} from './items.dto';
import { ItemsService, type MenuItem } from './items.service';

/**
 * Menu items (§5.2, §6.4).
 *
 * The availability route is the one place in this phase where a cashier or
 * barista may write: FR-3 says *any* staff member can 86 an item, because the
 * person who discovers the oat milk is gone is whoever is standing at the bar,
 * and making them find a manager first is how a kiosk keeps selling something
 * the cafe cannot make. Everything else here stays manager-and-above.
 */
@UseInterceptors(CatalogWriteInterceptor)
@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly itemOptionGroups: ItemOptionGroupsService,
    private readonly itemImages: ItemImageService,
  ) {}

  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(@Body() body: CreateItemDto): Promise<MenuItem> {
    return this.items.create(body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<MenuItem[]> {
    return this.items.list();
  }

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: ItemIdParamDto,
    @Body() body: UpdateItemDto,
  ): Promise<MenuItem> {
    return this.items.update(params.id, body);
  }

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Patch(':id/availability')
  setAvailability(
    @Param() params: ItemIdParamDto,
    @Body() body: SetItemAvailabilityDto,
  ): Promise<MenuItem> {
    return this.items.setAvailability(params.id, body.isAvailable);
  }

  /**
   * PUT, not PATCH: the body is the complete set of groups this item offers,
   * so sending it twice leaves the same rows (§5.2's "idempotent replace").
   */
  @Roles('ADMIN', 'MANAGER')
  @Put(':id/option-groups')
  setOptionGroups(
    @Param() params: ItemIdParamDto,
    @Body() body: SetItemOptionGroupsDto,
  ): Promise<AttachedOptionGroup[]> {
    return this.itemOptionGroups.setForItem(params.id, body.optionGroupIds);
  }

  /**
   * The one multipart route in the catalog (§5.1's carve-out from "JSON
   * everywhere"), and the only place the API accepts bytes it did not author.
   *
   * `memoryStorage` — the default — is deliberate: nothing untrusted is ever
   * written to the API's filesystem (§10), and the size limit below is what
   * makes buffering safe. `files: 1` refuses a form carrying a second part
   * rather than silently processing the first.
   *
   * 200 rather than POST's default 201, on the same reasoning as
   * `POST /devices/activate`: the resource this addresses already exists and
   * the response is that resource updated. Nothing was created at a URL the
   * caller could be pointed at.
   */
  @Roles('ADMIN', 'MANAGER')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @HttpCode(200)
  @Post(':id/image')
  uploadImage(
    @Param() params: ItemIdParamDto,
    @UploadedFile() file?: UploadedImage,
  ): Promise<MenuItem> {
    // multer leaves this undefined for a form with no `file` part at all,
    // which is a malformed request rather than a bad image.
    if (file === undefined) throw new ImageFileMissingError();
    return this.itemImages.replace(params.id, file);
  }
}
