import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { menuItems } from '../../database/schema';
import { ObjectStorageService } from '../../storage/object-storage.service';
import {
  ImageTypeUnsupportedError,
  ImageUnprocessableError,
} from '../errors/catalog.errors';
import { ItemsService, type MenuItem } from './items.service';

/**
 * Ceiling on what multer will buffer. A kiosk menu photo is a few hundred KB
 * once re-encoded; this is generous for a phone original while still bounding
 * what one authenticated manager can push into memory per request.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Decoded-pixel ceiling, which is the number that actually matters for a
 * decompression bomb: a 40 KB PNG can declare 30000x30000 and cost gigabytes
 * to decode. sharp's own default is ~0.27 gigapixels — far more headroom than
 * a cafe menu needs, and headroom is the attack.
 */
const MAX_INPUT_PIXELS = 40_000_000;

/** Longest edge of the stored image. Kiosk tiles are nowhere near this. */
const MAX_DIMENSION = 1600;

const WEBP_QUALITY = 82;
const OUTPUT_CONTENT_TYPE = 'image/webp';
const KEY_PREFIX = 'items';

/** What a client may declare, and what the bytes must actually turn out to be. */
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * Identifies the format from the bytes themselves.
 *
 * The declared `Content-Type` is chosen by the caller, so it is a hint and
 * never a decision (§10's "MIME + magic-byte check"). GIF and SVG are absent
 * on purpose — SVG is a document format that can carry script, and serving one
 * from the image origin would be stored XSS on a tablet the public can touch.
 */
function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(JPEG_MAGIC)) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).equals(RIFF_MAGIC) &&
    buffer.subarray(8, 12).equals(WEBP_MAGIC)
  ) {
    return 'image/webp';
  }
  return null;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_MAGIC = Buffer.from('WEBP', 'ascii');

/** The uploaded part, narrowed to what this service actually reads. */
export interface UploadedImage {
  mimetype: string;
  buffer: Buffer;
}

/**
 * Item photo uploads (§10, §12.4).
 *
 * Every upload is decoded and re-encoded rather than stored as sent. That is
 * the whole security posture in one sentence: whatever was uploaded — a
 * polyglot file, a JPEG with an appended ZIP, EXIF carrying the manager's home
 * GPS coordinates — does not survive a round trip through the decoder, because
 * what gets stored is pixels this process rendered, not bytes a client chose.
 */
@Injectable()
export class ItemImageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly items: ItemsService,
    private readonly storage: ObjectStorageService,
  ) {}

  async replace(itemId: string, file: UploadedImage): Promise<MenuItem> {
    // Checked before any decoding or uploading: a typo'd id is the common way
    // this fails, and it should not cost a re-encode or leave an object in the
    // bucket that nothing references.
    const exists = await this.db.query.menuItems.findFirst({
      where: eq(menuItems.id, itemId),
      columns: { id: true },
    });
    if (!exists) throw new ResourceNotFoundError('menu item', itemId);

    const image = await this.reencode(file);
    // Content-addressed: the same picture uploaded twice occupies one object,
    // and a key can only ever hold the bytes that hashed to it — which is what
    // makes the immutable cache header on it safe (§10).
    const digest = createHash('sha256').update(image).digest('hex');
    const stored = await this.storage.put(
      `${KEY_PREFIX}/${digest}.webp`,
      image,
      OUTPUT_CONTENT_TYPE,
    );

    // If the item vanished during the upload the object is orphaned. Accepted:
    // there is no delete route for items yet, and a bucket lifecycle rule is
    // the right place to reap unreferenced keys rather than a compensating
    // transaction spanning two systems.
    return this.items.update(itemId, { imageUrl: stored.url });
  }

  private async reencode(file: UploadedImage): Promise<Buffer> {
    // The cheap check first, so an obviously wrong upload never reaches the
    // decoder at all.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.mimetype as never)) {
      throw new ImageTypeUnsupportedError(ACCEPTED_IMAGE_TYPES);
    }
    if (sniffImageType(file.buffer) === null) {
      throw new ImageTypeUnsupportedError(ACCEPTED_IMAGE_TYPES);
    }

    try {
      return await sharp(file.buffer, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
      })
        // Applies the EXIF orientation while it is still known. Without this,
        // stripping metadata below turns every portrait phone photo sideways.
        .rotate()
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        // sharp drops metadata unless asked to keep it, so EXIF — including
        // GPS — is gone by omission rather than by a call someone can delete.
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      // The decoder's message names internals and is derived from hostile
      // input; the caller gets the fact, the stack goes nowhere.
      throw new ImageUnprocessableError();
    }
  }
}
