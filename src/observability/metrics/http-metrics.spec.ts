import { routeLabelOf, statusClassOf } from './http-metrics';

describe('routeLabelOf', () => {
  it('names the pattern the router matched', () => {
    expect(
      routeLabelOf({ baseUrl: '', route: { path: '/api/v1/orders/:id' } }),
    ).toBe('/api/v1/orders/:id');
  });

  it("keeps a mounted router's base path", () => {
    expect(routeLabelOf({ baseUrl: '/api', route: { path: '/orders' } })).toBe(
      '/api/orders',
    );
  });

  // A scanner walking random paths must not mint a series per path.
  it('collapses every unmatched request into one label', () => {
    expect(routeLabelOf({ baseUrl: '', route: undefined })).toBe('unmatched');
  });

  /**
   * nestjs-pino mounts its request logger as a route on `{*path}` under the
   * prefix. An unknown path matches that and nothing after it, so `req.route`
   * is left pointing at the logger rather than at an endpoint.
   */
  it('does not mistake the catch-all logger route for an endpoint', () => {
    expect(
      routeLabelOf({ baseUrl: '', route: { path: '/api/v1/{*path}' } }),
    ).toBe('unmatched');
  });
});

describe('statusClassOf', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [304, '3xx'],
    [404, '4xx'],
    [429, '4xx'],
    [503, '5xx'],
  ])('files %i under %s', (status, statusClass) => {
    expect(statusClassOf(status)).toBe(statusClass);
  });
});
