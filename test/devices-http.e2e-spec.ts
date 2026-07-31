import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface CreatedDeviceBody {
  id: string;
  name: string;
  status: string;
  pairingCode: string;
}

interface ActivatedDeviceBody {
  deviceId: string;
  name: string;
  deviceToken: string;
}

/** The `/devices` HTTP contract (§5.2, §6.2). */
describe('Device endpoints (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const createdOf = (res: { body: unknown }): CreatedDeviceBody =>
    res.body as CreatedDeviceBody;
  const activatedOf = (res: { body: unknown }): ActivatedDeviceBody =>
    res.body as ActivatedDeviceBody;

  /** Registers a device and tracks it so the harness cleans it up. */
  const createDevice = async (name = 'Counter Kiosk') => {
    const res = await harness
      .http()
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name });
    harness.trackDevice(createdOf(res).id);
    return res;
  };

  const activate = (pairingCode: string) =>
    harness.http().post('/api/v1/devices/activate').send({ pairingCode });

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('POST /devices', () => {
    it('creates a pending device and returns the pairing code once', async () => {
      const res = await createDevice('Window Kiosk');

      expect(res.status).toBe(201);
      expect(createdOf(res)).toMatchObject({
        name: 'Window Kiosk',
        status: 'PENDING',
      });
      expect(createdOf(res).pairingCode).toHaveLength(8);
    });

    it('never returns credential hashes', async () => {
      const res = await createDevice();

      expect(JSON.stringify(res.body)).not.toContain('Hash');
    });
  });

  describe('POST /devices/activate', () => {
    it('needs no credential — the code is the credential', async () => {
      const created = await createDevice();

      const res = await activate(createdOf(created).pairingCode);

      expect(res.status).toBe(200);
      expect(activatedOf(res).deviceId).toBe(createdOf(created).id);
      expect(activatedOf(res).deviceToken).not.toHaveLength(0);
    });

    it('issues a token that authenticates as a kiosk', async () => {
      const created = await createDevice();
      const activated = await activate(createdOf(created).pairingCode);

      const me = await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${activatedOf(activated).deviceToken}`);

      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ type: 'device', role: 'KIOSK' });
    });

    it('answers 401 DEVICE_PAIRING_INVALID for a wrong code', async () => {
      const res = await activate('ZZZZ9999');

      expect(res.status).toBe(401);
      expect(problemOf(res).code).toBe('DEVICE_PAIRING_INVALID');
    });

    it('tolerates the whitespace and case a human types', async () => {
      const created = await createDevice();

      const res = await activate(
        `  ${createdOf(created).pairingCode.toLowerCase()} `,
      );

      expect(res.status).toBe(200);
    });

    it('rejects a code of the wrong shape before it reaches the database', async () => {
      const res = await activate('!!');

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    // The code is a credential; it must not come back in the envelope that
    // gets logged and shown on the kiosk's error screen.
    it('never echoes the rejected code', async () => {
      const res = await activate('ZZZZ9999');

      expect(JSON.stringify(res.body)).not.toContain('ZZZZ9999');
    });
  });

  describe('GET /devices', () => {
    it('lists the fleet without any credential material', async () => {
      await createDevice();

      const res = await harness
        .http()
        .get('/api/v1/devices')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');
      expect(JSON.stringify(res.body)).not.toContain('pairingCode');
    });
  });

  describe('PATCH /devices/:id', () => {
    it('pauses ordering on a paired device', async () => {
      const created = await createDevice();
      await activate(createdOf(created).pairingCode);

      const res = await harness
        .http()
        .patch(`/api/v1/devices/${createdOf(created).id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'PAUSED' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'PAUSED' });
    });

    it('refuses REVOKED as a status — that is its own endpoint', async () => {
      const created = await createDevice();
      await activate(createdOf(created).pairingCode);

      const res = await harness
        .http()
        .patch(`/api/v1/devices/${createdOf(created).id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'REVOKED' });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /devices/:id/revoke', () => {
    it('answers 204 and kills the token', async () => {
      const created = await createDevice();
      const activated = await activate(createdOf(created).pairingCode);
      const token = activatedOf(activated).deviceToken;

      const res = await harness
        .http()
        .post(`/api/v1/devices/${createdOf(created).id}/revoke`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(204);

      const afterwards = await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(afterwards.status).toBe(401);
      expect(problemOf(afterwards).code).toBe('DEVICE_REVOKED');
    });

    it('answers 404 for a device nobody registered', async () => {
      const res = await harness
        .http()
        .post(`/api/v1/devices/${uuidv7()}/revoke`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(404);
    });
  });
});
