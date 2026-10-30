import { tracingOptionsFrom } from './tracing';

const ENDPOINT = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' };

describe('tracingOptionsFrom', () => {
  // A laptop, a test run and CI have no collector; tracing must cost nothing there.
  it('is off without an endpoint to export to', () => {
    expect(tracingOptionsFrom({})).toBeNull();
  });

  it('is on when either OTLP endpoint variable is set', () => {
    expect(tracingOptionsFrom(ENDPOINT)).not.toBeNull();
    expect(
      tracingOptionsFrom({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
      }),
    ).not.toBeNull();
  });

  it('samples 10% by default, as section 13 specifies', () => {
    expect(tracingOptionsFrom(ENDPOINT)?.sampleRatio).toBe(0.1);
  });

  it('takes the ratio from the standard variable', () => {
    expect(
      tracingOptionsFrom({ ...ENDPOINT, OTEL_TRACES_SAMPLER_ARG: '1' })
        ?.sampleRatio,
    ).toBe(1);
  });

  it('refuses a ratio that is not between 0 and 1', () => {
    expect(() =>
      tracingOptionsFrom({ ...ENDPOINT, OTEL_TRACES_SAMPLER_ARG: '10%' }),
    ).toThrow(/OTEL_TRACES_SAMPLER_ARG/);
    expect(() =>
      tracingOptionsFrom({ ...ENDPOINT, OTEL_TRACES_SAMPLER_ARG: '1.5' }),
    ).toThrow(/OTEL_TRACES_SAMPLER_ARG/);
  });

  it('names the service cafe-pos unless told otherwise', () => {
    expect(tracingOptionsFrom(ENDPOINT)?.serviceName).toBe('cafe-pos');
    expect(
      tracingOptionsFrom({ ...ENDPOINT, OTEL_SERVICE_NAME: 'cafe-pos-b' })
        ?.serviceName,
    ).toBe('cafe-pos-b');
  });
});
