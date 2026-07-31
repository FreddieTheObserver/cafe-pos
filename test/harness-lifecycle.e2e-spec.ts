import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * Guards the e2e harness against a footgun that cost a CI run.
 *
 * supertest's `serverAddress()` calls `app.listen(0)` when it is handed a
 * server that is not listening — and the `Test` that did so then *closes* that
 * shared server as soon as its own request finishes. For sequential requests
 * that is invisible. For a `Promise.all` burst it means the first request to
 * complete shuts the server down underneath its siblings, and whichever of them
 * had not finished connecting yet dies with ECONNRESET.
 *
 * It is timing-dependent, so it passes on a fast laptop and fails on a loaded
 * CI runner. Asserting the *invariant* — the harness owns the server and it
 * stays up — is deterministic, which asserting the symptom is not.
 */
describe('IdentityHarness HTTP lifecycle (e2e)', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
  });

  const isListening = () =>
    (harness.app.getHttpServer() as { listening: boolean }).listening;

  it('is already listening before any request is made', () => {
    expect(isListening()).toBe(true);
  });

  it('is still listening after a sequential request', async () => {
    await harness.http().get('/healthz');

    expect(isListening()).toBe(true);
  });

  it('survives a concurrent burst with the server still up', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        harness
          .http()
          .get('/healthz')
          .then((res) => res.status),
      ),
    );

    expect(statuses.every((status) => status === 200)).toBe(true);
    // The assertion that actually catches the bug: supertest must never have
    // taken ownership of the server, so nothing can close it mid-suite.
    expect(isListening()).toBe(true);
  });

  it('is still usable after the burst', async () => {
    const res = await harness.http().get('/healthz');

    expect(res.status).toBe(200);
  });
});
