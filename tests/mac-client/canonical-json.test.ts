import { canonicalJson as clientCanonicalJson } from '../../client-core/src/canonicalJson';
import { canonicalJson as bridgeCanonicalJson } from '../../bridge/src/canonical';

describe('client-core canonicalJson parity with bridge canonical', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['empty string', ''],
    ['string', 'session prompt text'],
    ['unicode string', 'ünïcødé ✓ "quoted" \\'],
    ['zero', 0],
    ['negative zero', -0],
    ['integer', 1_800_000_000_000],
    ['negative integer', -17],
    ['float', 3.14159],
    ['empty array', []],
    ['array', [1, 'a', null, true, { nested: [2] }]],
    ['empty object', {}],
    ['flat object', { a: 1, b: 'x', c: false }],
    ['nested object', { z: 1, a: { y: true, b: ['value', null] } }],
    ['empty key', { '': 'v' }],
    [
      'envelope-shaped object',
      {
        protocolVersion: 2,
        bridgeId: 'bridge_1234567890',
        deviceId: 'device_1234567890',
        requestId: 'req',
        issuedAt: 1_800_000_000_000,
        expiresAt: 1_800_000_015_000,
        nonce: 'n',
        method: 'session.list',
        body: { cursor: 'c', interaction: true },
      },
    ],
  ];

  it.each(cases)('produces identical output for %s', (_label, value) => {
    expect(clientCanonicalJson(value)).toBe(bridgeCanonicalJson(value));
  });

  it('canonicalizes recursively for stable signatures', () => {
    expect(clientCanonicalJson({ z: 1, a: { y: true, b: ['value', null] } })).toBe(
      clientCanonicalJson({ a: { b: ['value', null], y: true }, z: 1 }),
    );
    expect(clientCanonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['nested NaN', { a: { b: Number.NaN } }],
  ])('throws the same way on %s', (_label, value) => {
    expect(() => clientCanonicalJson(value)).toThrow();
    expect(() => bridgeCanonicalJson(value)).toThrow();
  });
});
