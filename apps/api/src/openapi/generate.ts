import './placeholder-env';
import { readFileSync } from 'node:fs';
import { AppModule } from '../app.module';
import { buildDocument, responseTypeNames } from './build-document';
import { readReturnTypes } from './response-types';
import { scanRoutes } from './scan-routes';
import { generateTypeSchemas } from './type-schemas';

// Relative to apps/api, which is where `pnpm openapi` runs.
export async function generateDocument() {
  const routes = await scanRoutes(AppModule);
  const returnTypes = readReturnTypes('src');
  const typeSchemas = generateTypeSchemas(
    responseTypeNames(routes, returnTypes),
    { path: 'src/**/*.controller.ts', tsconfig: 'tsconfig.json' },
  );
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
  };
  return buildDocument({ routes, returnTypes, typeSchemas, version });
}
