import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../config/env.validation';
import { S3_CLIENT } from './storage.constants';

/**
 * The API and its object storage start concurrently — `docker compose up`
 * brings both up at once, and CI starts MinIO in the step before the suite. A
 * bucket check that fails on the first blip would make a cold start a coin
 * flip, which is exactly what it was before this loop existed: one cold run in
 * four failed here, and every test in the suite went red because the app never
 * finished booting.
 *
 * This does not soften the fail-fast policy. An endpoint that is genuinely
 * wrong is still wrong five attempts later, and the boot still refuses.
 */
const READINESS_ATTEMPTS = 5;
const READINESS_DELAY_MS = 1000;

export interface StoredObject {
  /** Key within the bucket, e.g. `items/3f2a....webp`. */
  key: string;
  /** Absolute URL a client fetches the object from, via the CDN origin. */
  url: string;
}

/**
 * Writes to the object store behind the CDN (§10, §12.4).
 *
 * Deliberately thin and free of image knowledge: what a valid item photo is
 * belongs to the catalog, and this only knows how to put bytes somewhere
 * durable and say where they landed. That split is what lets Phase 4 or 7 store
 * something else — an export, a receipt — without touching image code.
 */
@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly autoCreateBucket: boolean;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<Env, true>,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.publicBaseUrl = config.get('S3_PUBLIC_BASE_URL', { infer: true });
    this.autoCreateBucket = config.get('S3_AUTO_CREATE_BUCKET', {
      infer: true,
    });
  }

  /**
   * Fails the boot if the bucket is unreachable, rather than letting the first
   * upload of the day be the thing that discovers it.
   *
   * This is the same argument `JWT_SECRET`'s length floor makes: a
   * misconfiguration that surfaces at deploy time costs a rollback, and one
   * that surfaces at 08:00 costs a manager standing at a screen that will not
   * accept a photo.
   */
  async onModuleInit(): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
      try {
        await this.ensureBucket();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < READINESS_ATTEMPTS) await delay(READINESS_DELAY_MS);
      }
    }

    throw new Error(
      `Object storage bucket "${this.bucket}" is not reachable after ${READINESS_ATTEMPTS} attempts. ` +
        `Check S3_ENDPOINT and credentials, or set S3_AUTO_CREATE_BUCKET=true for local development. ` +
        `Cause: ${String(lastError)}`,
    );
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      // Without auto-create there is nothing else to try, so let the caller
      // count this as a failed attempt rather than inventing a bucket.
      if (!this.autoCreateBucket) throw error;
    }

    // Only reached with auto-create on, which is MinIO and CI. A second
    // instance racing us here loses harmlessly: the bucket it wanted exists.
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created object storage bucket "${this.bucket}".`);
    } catch (error) {
      if (!isBucketAlreadyOwned(error)) throw error;
    }

    await this.allowPublicReads();
  }

  /**
   * Makes objects anonymously readable — only ever on the auto-created bucket.
   *
   * In production this bucket sits behind a CDN and is public by
   * infrastructure, not by the application; that path never reaches here,
   * because `S3_AUTO_CREATE_BUCKET` defaults to false and a real deployment
   * points at a bucket that already exists. Locally it is what makes the URL
   * this service hands back actually load in a browser, which is the whole
   * point of storing one. A MinIO bucket is private by default, so without
   * this every item photo in development is a broken image.
   */
  private async allowPublicReads(): Promise<void> {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        },
      ],
    };

    await this.s3.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: JSON.stringify(policy),
      }),
    );
  }

  /**
   * Stores bytes under a caller-chosen key and returns where to read them.
   *
   * `immutable` caching is safe because callers key by content hash: the same
   * key can only ever hold the same bytes, so a client that has it never needs
   * to ask again. That is what makes item images free to serve (§10's
   * "immutable URLs (content-hash names)").
   */
  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { key, url: `${this.publicBaseUrl}/${key}` };
  }
}

/** S3 and MinIO both report a re-create as one of these two codes. */
function isBucketAlreadyOwned(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
