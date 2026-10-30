import './placeholder-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_METHODS,
} from '../bootstrap';
import { CatalogErrorCode } from '../catalog/errors/catalog.errors';
import { ErrorCode } from '../common/errors/error-codes';
import * as enums from '../database/schema/enums';
import { IdentityErrorCode } from '../identity/errors/identity.errors';
import { principalRoles } from '../identity/principal';
import { OrderErrorCode } from '../orders/errors/orders.errors';
import { PaymentErrorCode } from '../payments/errors/payments.errors';
import { responsesOf } from './build-document';
import { DOCS_DIR } from './repo-paths';
import { readReturnTypes } from './response-types';
import { scanRoutes } from './scan-routes';

const DOC = readFileSync(join(DOCS_DIR, 'api.md'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function tableRows(from: string, to: string): string[][] {
  const start = DOC.indexOf(from);
  const end = DOC.indexOf(to, start + from.length);
  if (start < 0 || end < 0) {
    throw new Error(`docs/api.md no longer has the section ${from} ... ${to}`);
  }
  return DOC.slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, line.lastIndexOf('|'))
        .split(' | ')
        .map((cell) => cell.trim()),
    );
}

const tokens = (cell: string): string[] => [
  ...new Set([...cell.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1])),
];

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());

const ROLE_LETTERS: Record<string, string> = {
  A: 'ADMIN',
  M: 'MANAGER',
  C: 'CASHIER',
  B: 'BARISTA',
  K: 'KIOSK',
};

describe('docs/api.md agrees with the code', () => {
  it('lists every route, with the roles and statuses the code gives it', async () => {
    const returnTypes = readReturnTypes('src');
    const actual = new Map<string, string>();
    for (const route of await scanRoutes(AppModule)) {
      const roles =
        route.roles === 'public' ? 'public' : [...route.roles].sort().join(' ');
      const statuses = Object.keys(responsesOf(route, returnTypes)).sort();
      actual.set(
        `${route.method.toUpperCase()} ${route.path}`,
        `${roles} | ${statuses.join(',')}`,
      );
    }

    const documented = new Map<string, string>();
    for (const [route, roles, success] of tableRows(
      '### Index',
      '### Errors that apply everywhere',
    )) {
      const match = /^`(\w+) (\S+)`(?: \((.+)\))?$/.exec(route);
      if (!match) throw new Error(`Unreadable index row: ${route}`);
      const [, method, path, note] = match;
      // The metrics listener is a separate port, outside the HTTP contract.
      if (note?.startsWith('port')) continue;

      const template = path.replace(/:(\w+)/g, '{$1}');
      const rolesCell = roles.replace(/\(own\)/, '').trim();
      documented.set(
        `${method} ${note === 'root' ? template : `/api/v1${template}`}`,
        `${
          rolesCell.startsWith('public')
            ? 'public'
            : rolesCell
                .split(/\s+/)
                .map((letter) => ROLE_LETTERS[letter] ?? letter)
                .sort()
                .join(' ')
        } | ${success
          .split(',')
          .map((status) => status.trim())
          .sort()
          .join(',')}`,
      );
    }

    const differences = [
      ...[...actual.keys()]
        .filter((key) => !documented.has(key))
        .map((key) => `in the code, not in the index: ${key}`),
      ...[...documented.keys()]
        .filter((key) => !actual.has(key))
        .map((key) => `in the index, not in the code: ${key}`),
      ...[...actual]
        .filter(
          ([key, value]) =>
            documented.has(key) && documented.get(key) !== value,
        )
        .map(
          ([key, value]) =>
            `${key}: code says "${value}", index says "${documented.get(key)}"`,
        ),
    ];
    expect(differences).toEqual([]);
    expect(actual.size).toBeGreaterThan(40);
  });

  it('documents every error code, and only codes that exist', () => {
    const inCode: string[] = [
      ErrorCode,
      CatalogErrorCode,
      IdentityErrorCode,
      OrderErrorCode,
      PaymentErrorCode,
    ].flatMap((codes) => Object.values(codes));
    const documented = tableRows(
      '### 3.4 Error code catalog',
      '### 3.5 Reacting to errors',
    ).map(([code]) => code.replace(/`/g, ''));

    expect(inCode.filter((code) => !documented.includes(code))).toEqual([]);
    expect(documented.filter((code) => !inCode.includes(code))).toEqual([]);
    expect(documented.length).toBeGreaterThan(30);
  });

  it('documents every enumeration with the values the code allows', () => {
    const inCode: Record<string, readonly string[]> = {
      UserRole: enums.userRoles,
      DeviceStatus: enums.deviceStatuses,
      OrderChannel: enums.orderChannels,
      OrderStatus: enums.orderStatuses,
      ActorType: enums.actorTypes,
      PaymentProvider: enums.paymentProviders,
      PaymentMethod: enums.paymentMethods,
      PaymentStatus: enums.paymentStatuses,
      RefundStatus: enums.refundStatuses,
    };
    const documented = tableRows(
      '### 1.6 Enumerations',
      '## 2. Authentication and authorization',
    ).map(
      ([name, values]) => [name.replace(/`/g, ''), tokens(values)] as const,
    );

    expect(documented.map(([name]) => name).sort()).toEqual(
      Object.keys(inCode).sort(),
    );
    for (const [name, values] of documented) {
      expect([name, sameSet(values, inCode[name] ?? [])]).toEqual([name, true]);
    }
  });

  it('documents the CORS policy the code applies', () => {
    const documented = new Map(
      tableRows('### 4.5 CORS', '### 4.6 The order lifecycle').map(
        ([setting, value]) =>
          [
            setting,
            [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
          ] as const,
      ),
    );

    const inCode: Record<string, readonly string[]> = {
      Methods: CORS_METHODS,
      'Request headers allowed': CORS_ALLOWED_HEADERS,
      'Response headers exposed': CORS_EXPOSED_HEADERS,
    };
    for (const [setting, values] of Object.entries(inCode)) {
      expect([setting, documented.get(setting)]).toEqual([setting, values]);
    }
  });

  it('documents every role', () => {
    const documented = tableRows('### 1.5 Roles', '### 1.6 Enumerations').map(
      ([role]) => role.replace(/`/g, ''),
    );

    expect(documented.sort()).toEqual([...principalRoles].sort());
  });
});
