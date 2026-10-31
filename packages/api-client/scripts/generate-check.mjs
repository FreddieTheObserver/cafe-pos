// Fails when src/generated/schema.d.ts is stale against docs/openapi.json.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'src/generated/schema.d.ts';
const before = readFileSync(FILE, 'utf8');
execSync('pnpm run generate', { stdio: 'ignore' });
const after = readFileSync(FILE, 'utf8');
if (before !== after) {
  console.error(`${FILE} is out of date. Run \`pnpm --filter @cafepos/api-client generate\` and commit it.`);
  process.exit(1);
}
console.log(`${FILE} is up to date.`);
