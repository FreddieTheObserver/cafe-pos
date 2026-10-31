// Fails when src/generated/schema.d.ts is stale against docs/openapi.json.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'src/generated/schema.d.ts';
const read = () => readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const before = read();
execSync('pnpm run generate', { stdio: 'ignore' });
const after = read();
if (before !== after) {
  console.error(`${FILE} is out of date. Run \`pnpm --filter @cafepos/api-client generate\` and commit it.`);
  process.exit(1);
}
console.log(`${FILE} is up to date.`);
