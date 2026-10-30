import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateDocument } from '../src/openapi/generate';

const FILE = 'docs/openapi.json';

async function main(): Promise<void> {
  const document = await generateDocument();

  const { Validator } = await import('@seriousme/openapi-schema-validator');
  const result = await new Validator().validate(document);
  if (!result.valid) {
    console.error('The generated document is not valid OpenAPI:');
    console.error(JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = existsSync(FILE)
      ? readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
      : '';
    if (current !== text) {
      console.error(
        `${FILE} is out of date. Run \`pnpm openapi\` and commit it.`,
      );
      process.exit(1);
    }
    console.log(`${FILE} is up to date.`);
    return;
  }

  writeFileSync(FILE, text);
  console.log(`Wrote ${FILE}.`);
}

void main();
