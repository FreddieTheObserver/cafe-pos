import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { MetricsModule } from '../src/observability/metrics/metrics.module';
import {
  ProbeModule,
  RecordingErrorReportingModule,
  StubbedHealthModule,
  recordingReporter,
} from './fixtures/probe.module';

const ALLOWED_ORIGIN = 'https://kds.cafe.test';

describe('HTTP hardening (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ProbeModule,
        StubbedHealthModule,
        MetricsModule,
        RecordingErrorReportingModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, { corsOrigins: [ALLOWED_ORIGIN] });
    // Bound here rather than left to supertest, which would take ownership of
    // the server and close it — see the note in `fixtures/identity-fixtures.ts`.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** supertest types `body` as `any`; every error path here returns an envelope. */
  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  describe('API base path', () => {
    it('serves API routes under /api/v1', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'Latte', quantity: 1 });

      expect(res.status).toBe(201);
    });

    it('does not serve API routes at the unversioned path', async () => {
      const res = await http()
        .post('/probe/echo')
        .send({ name: 'Latte', quantity: 1 });

      expect(res.status).toBe(404);
    });

    it('keeps liveness at the root where orchestrators look for it', async () => {
      const res = await http().get('/healthz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('keeps readiness at the root where orchestrators look for it', async () => {
      const res = await http().get('/readyz');

      expect(res.status).toBe(200);
    });

    it('does not also mount the probes under the base path', async () => {
      const [liveness, readiness] = await Promise.all([
        http().get('/api/v1/healthz'),
        http().get('/api/v1/readyz'),
      ]);

      expect(liveness.status).toBe(404);
      expect(readiness.status).toBe(404);
    });
  });

  describe('security headers', () => {
    it('sets nosniff so a JSON error body is never sniffed as HTML', async () => {
      const res = await http().post('/api/v1/probe/echo').send({});

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('stops advertising the framework in X-Powered-By', async () => {
      const res = await http().post('/api/v1/probe/echo').send({});

      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('allows a configured browser origin', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ name: 'Latte', quantity: 1 });

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });

    it('does not grant access to an unlisted origin', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .set('Origin', 'https://evil.test')
        .send({ name: 'Latte', quantity: 1 });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('body size limit', () => {
    it('accepts a normally sized payload', async () => {
      const res = await http()
        .post('/api/v1/probe/bulk')
        .send({ note: 'x'.repeat(1024) });

      expect(res.status).toBe(201);
    });

    it('rejects a payload above the limit with 413', async () => {
      // 96 KB: under Express's 100 KB default, over our configured 64 KB —
      // so this fails if the limit silently falls back to the default.
      const res = await http()
        .post('/api/v1/probe/bulk')
        .send({ note: 'x'.repeat(96 * 1024) });

      expect(res.status).toBe(413);
    });
  });

  describe('validation envelope', () => {
    it('answers 422 in the Problem Details shape when the body is invalid', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
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
        .post('/api/v1/probe/echo')
        .send({ name: '', quantity: 999 });

      const fields = problemOf(res).errors?.map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['name', 'quantity']));
    });

    it('passes a valid body through to the handler', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'Latte', quantity: '2' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ name: 'Latte', quantity: 2 });
    });
  });

  describe('error reporting', () => {
    beforeEach(() => {
      recordingReporter.reports.length = 0;
    });

    it('reports an unplanned failure once, with the request it came from', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/fault');

      expect(res.status).toBe(500);
      expect(recordingReporter.reports).toHaveLength(1);
      expect(recordingReporter.reports[0].error).toBeInstanceOf(Error);
      expect(recordingReporter.reports[0].context).toEqual({
        // The same id the client was given, so a support call can find the report.
        requestId: (res.body as ProblemDetails).requestId,
        method: 'GET',
        route: '/api/v1/probe/fault',
      });
    });

    // A dependency outage has its own alert; paging Sentry per request would bury real faults.
    it('does not report a deliberate 503', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/probe/unavailable',
      );

      expect(res.status).toBe(503);
      expect(recordingReporter.reports).toHaveLength(0);
    });

    it('does not report a client error', async () => {
      await request(app.getHttpServer()).post('/api/v1/probe/echo').send({});

      expect(recordingReporter.reports).toHaveLength(0);
    });
  });
});
