import { inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface ItemBody {
  id: string;
  name: string;
  imageUrl: string | null;
}

/**
 * `POST /items/:id/image` (§5.1's multipart carve-out, §10's validation rules).
 *
 * Fixtures are produced by a real encoder rather than hand-written byte
 * arrays. Phase 0 shipped three defects behind invented fixtures, and an
 * upload pipeline is exactly where that goes wrong: a made-up "PNG" would
 * exercise the magic-byte check and nothing past it, leaving the part that
 * actually decodes untested.
 */
describe('Item image upload (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let categoryId: string;

  const itemIds: string[] = [];
  const categoryIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const itemOf = (res: { body: unknown }): ItemBody => res.body as ItemBody;

  const upload = (
    itemId: string,
    file: Buffer,
    filename: string,
    contentType: string,
  ) =>
    harness
      .http()
      .post(`/api/v1/items/${itemId}/image`)
      .set('Authorization', `Bearer ${managerToken}`)
      .attach('file', file, { filename, contentType });

  const seedItem = async (): Promise<string> => {
    const res = await harness
      .http()
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        categoryId,
        name: `Latte ${uuidv7()}`,
        basePriceMinor: 9500,
      });
    if (res.status !== 201) {
      throw new Error(`fixture item failed with ${res.status}`);
    }
    const id = (res.body as { id: string }).id;
    itemIds.push(id);
    return id;
  };

  /** A real PNG of the given size, with distinct pixels so it is compressible but not empty. */
  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 80, b: 40 },
      },
    })
      .png()
      .toBuffer();

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');

    const category = await harness
      .http()
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: `Drinks ${uuidv7()}` });
    categoryId = (category.body as { id: string }).id;
    categoryIds.push(categoryId);
  });

  afterAll(async () => {
    try {
      if (itemIds.length > 0) {
        await harness.db
          .delete(schema.menuItems)
          .where(inArray(schema.menuItems.id, itemIds));
      }
      if (categoryIds.length > 0) {
        await harness.db
          .delete(schema.categories)
          .where(inArray(schema.categories.id, categoryIds));
      }
    } finally {
      await harness.close();
    }
  });

  describe('the happy path', () => {
    it('stores the image and points the item at it', async () => {
      const itemId = await seedItem();

      const res = await upload(
        itemId,
        await png(800, 600),
        'latte.png',
        'image/png',
      );

      expect(res.status).toBe(200);
      expect(itemOf(res).imageUrl).toMatch(
        /^http:\/\/localhost:9000\/cafepos-media\/items\/[0-9a-f]{64}\.webp$/,
      );
    });

    /**
     * The URL stored has to be the URL that serves the bytes. Fetching it over
     * plain HTTP — not through the S3 client — is what proves the public base
     * URL, the bucket policy, and the key all line up; an SDK round trip would
     * pass even if the object were unreachable to a browser.
     */
    it('serves the stored object from the URL it handed back', async () => {
      const itemId = await seedItem();
      const res = await upload(
        itemId,
        await png(800, 600),
        'latte.png',
        'image/png',
      );

      const fetched = await fetch(itemOf(res).imageUrl as string);

      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe('image/webp');
      // Immutable: the key is a content hash, so the bytes behind it can never
      // change and a client that has them never needs to revalidate.
      expect(fetched.headers.get('cache-control')).toContain('immutable');
    });

    it('re-encodes to webp regardless of what was uploaded', async () => {
      const itemId = await seedItem();
      const res = await upload(
        itemId,
        await png(800, 600),
        'latte.png',
        'image/png',
      );

      const fetched = await fetch(itemOf(res).imageUrl as string);
      const meta = await sharp(
        Buffer.from(await fetched.arrayBuffer()),
      ).metadata();

      expect(meta.format).toBe('webp');
    });

    it('downscales an oversized image to the long-edge bound', async () => {
      const itemId = await seedItem();

      const res = await upload(
        itemId,
        await png(4000, 2000),
        'huge.png',
        'image/png',
      );

      const fetched = await fetch(itemOf(res).imageUrl as string);
      const meta = await sharp(
        Buffer.from(await fetched.arrayBuffer()),
      ).metadata();

      expect(meta.width).toBe(1600);
      expect(meta.height).toBe(800);
    });

    // Content-addressed storage: the same picture is one object however many
    // times it is uploaded.
    it('gives the same URL to identical bytes', async () => {
      const image = await png(640, 480);
      const first = await upload(await seedItem(), image, 'a.png', 'image/png');
      const second = await upload(
        await seedItem(),
        image,
        'b.png',
        'image/png',
      );

      expect(itemOf(second).imageUrl).toBe(itemOf(first).imageUrl);
    });

    /**
     * EXIF can carry the photographer's GPS coordinates, and these photos are
     * taken on a manager's phone and served to the public. sharp drops
     * metadata unless asked to keep it, so this pins the absence rather than
     * trusting a default nobody re-checks.
     */
    it('strips EXIF from the stored image', async () => {
      const withExif = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 10, g: 120, b: 200 },
        },
      })
        .withExif({ IFD0: { Copyright: 'cafepos-test', Artist: 'fixture' } })
        .jpeg()
        .toBuffer();
      // The fixture is only meaningful if it really carries EXIF to begin with.
      expect((await sharp(withExif).metadata()).exif).toBeDefined();

      const res = await upload(
        await seedItem(),
        withExif,
        'phone.jpg',
        'image/jpeg',
      );

      const fetched = await fetch(itemOf(res).imageUrl as string);
      const meta = await sharp(
        Buffer.from(await fetched.arrayBuffer()),
      ).metadata();

      expect(meta.exif).toBeUndefined();
    });

    // The upload changes the menu, so it has to move the cache version like
    // every other catalog write — it goes through the same interceptor.
    it('invalidates the cached menu', async () => {
      const itemId = await seedItem();
      const before = await harness
        .http()
        .get('/api/v1/menu')
        .set('Authorization', `Bearer ${managerToken}`);

      await upload(itemId, await png(320, 240), 'x.png', 'image/png');

      const after = await harness
        .http()
        .get('/api/v1/menu')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(after.headers.etag).not.toBe(before.headers.etag);
    });
  });

  describe('what it refuses', () => {
    /**
     * The declared content type is chosen by the caller, so it cannot be the
     * decision. These bytes are a plain text file wearing `image/png`.
     */
    it('rejects non-image bytes declaring an image type', async () => {
      const res = await upload(
        await seedItem(),
        Buffer.from('#!/bin/sh\necho not an image\n', 'utf8'),
        'payload.png',
        'image/png',
      );

      expect(res.status).toBe(415);
      expect(problemOf(res).code).toBe('IMAGE_TYPE_UNSUPPORTED');
    });

    // SVG is a document format that can carry script; serving one from the
    // image origin would be stored XSS on a tablet the public can touch.
    it('rejects SVG outright', async () => {
      const res = await upload(
        await seedItem(),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
        'vector.svg',
        'image/svg+xml',
      );

      expect(res.status).toBe(415);
      expect(problemOf(res).code).toBe('IMAGE_TYPE_UNSUPPORTED');
    });

    /**
     * Real PNG magic bytes, real PNG header, but the pixel data is cut off —
     * so this gets past the sniff and dies in the decoder, which is the only
     * way to reach the second of the two failure modes.
     */
    it('rejects a truncated image as unprocessable, not as the wrong type', async () => {
      const whole = await png(600, 400);

      const res = await upload(
        await seedItem(),
        whole.subarray(0, 64),
        'cut.png',
        'image/png',
      );

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('IMAGE_UNPROCESSABLE');
    });

    // multer aborts the stream at the limit, so this never buffers 6 MB. The
    // mapping matters: without it the filter would call this a 500 and page
    // somebody over a manager picking too big a photo.
    it('rejects an upload over the size limit with 413', async () => {
      const oversized = Buffer.alloc(6 * 1024 * 1024, 7);
      // Real PNG magic, so a rejection can only have come from the size limit.
      (await png(8, 8)).copy(oversized, 0, 0, 8);

      const res = await upload(
        await seedItem(),
        oversized,
        'huge.png',
        'image/png',
      );

      expect(res.status).toBe(413);
      expect(problemOf(res).code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects a form with no file part', async () => {
      const itemId = await seedItem();

      const res = await harness
        .http()
        .post(`/api/v1/items/${itemId}/image`)
        .set('Authorization', `Bearer ${managerToken}`)
        .field('notTheFile', 'x');

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('IMAGE_FILE_MISSING');
    });

    // Checked before any decoding or uploading, so a typo'd id costs neither a
    // re-encode nor an object nothing references.
    it('answers 404 for an item nobody holds', async () => {
      const res = await upload(
        uuidv7(),
        await png(320, 240),
        'x.png',
        'image/png',
      );

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });
});
