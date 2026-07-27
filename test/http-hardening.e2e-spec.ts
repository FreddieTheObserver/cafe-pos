import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { ProbeModule } from './fixtures/probe.module';

const ALLOWED_ORIGIN = 'https://kds.cafe.test';

describe('HTTP hardening (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, { corsOrigins: [ALLOWED_ORIGIN] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** supertest types `body` as `any`; every error path here returns an envelope. */
  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  describe('security headers', () => {
    it('sets nosniff so a JSON error body is never sniffed as HTML', async () => {
      const res = await http().post('/probe/echo').send({});

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('stops advertising the framework in X-Powered-By', async () => {
      const res = await http().post('/probe/echo').send({});

      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('allows a configured browser origin', async () => {
      const res = await http()
        .post('/probe/echo')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ name: 'Latte', quantity: 1 });

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });

    it('does not grant access to an unlisted origin', async () => {
      const res = await http()
        .post('/probe/echo')
        .set('Origin', 'https://evil.test')
        .send({ name: 'Latte', quantity: 1 });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('body size limit', () => {
    it('accepts a normally sized payload', async () => {
      const res = await http()
        .post('/probe/bulk')
        .send({ note: 'x'.repeat(1024) });

      expect(res.status).toBe(201);
    });

    it('rejects a payload above the limit with 413', async () => {
      // 96 KB: under Express's 100 KB default, over our configured 64 KB —
      // so this fails if the limit silently falls back to the default.
      const res = await http()
        .post('/probe/bulk')
        .send({ note: 'x'.repeat(96 * 1024) });

      expect(res.status).toBe(413);
    });
  });

  describe('validation envelope', () => {
    it('answers 422 in the Problem Details shape when the body is invalid', async () => {
      const res = await http()
        .post('/probe/echo')
        .send({ name: '', quantity: 999 });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        type: 'https://cafepos.dev/errors/validation-failed',
        title: 'Validation failed',
        status: 422,
        code: 'VALIDATION_FAILED',
      });
      expect(problemOf(res).requestId).toEqual(expect.any(String));
    });

    it('lists each offending field in errors[]', async () => {
      const res = await http()
        .post('/probe/echo')
        .send({ name: '', quantity: 999 });

      const fields = problemOf(res).errors?.map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['name', 'quantity']));
    });

    it('passes a valid body through to the handler', async () => {
      const res = await http()
        .post('/probe/echo')
        .send({ name: 'Latte', quantity: '2' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ name: 'Latte', quantity: 2 });
    });
  });
});
