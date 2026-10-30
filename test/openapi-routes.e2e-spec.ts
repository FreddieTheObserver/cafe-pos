import { AppModule } from '../src/app.module';
import { scanRoutes } from '../src/openapi/scan-routes';
import { IdentityHarness } from './fixtures/identity-fixtures';
import { registeredApiRoutes } from './fixtures/registered-routes';

describe('OpenAPI route scan (e2e)', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  it('finds exactly the routes Express serves', async () => {
    const scanned = (await scanRoutes(AppModule))
      .filter((route) => route.path.startsWith('/api/v1/'))
      .map(
        (route) => `${route.method} ${route.path.replace(/\{(\w+)\}/g, ':$1')}`,
      )
      .sort();

    expect(scanned).toEqual(registeredApiRoutes(harness.app).sort());
    expect(scanned.length).toBeGreaterThan(40);
  });
});
