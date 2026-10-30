import { join } from 'node:path';

// Resolved from this file, so it holds whichever directory a script or test runs from.
export const DOCS_DIR = join(__dirname, '..', '..', '..', '..', 'docs');
