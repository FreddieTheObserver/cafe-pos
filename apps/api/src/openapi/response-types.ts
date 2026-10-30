import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type ReturnRef =
  | { kind: 'none' }
  | { kind: 'type'; name: string; array: boolean }
  | { kind: 'unnamed'; text: string }
  | { kind: 'missing' };

export function refOf(annotation: string | undefined): ReturnRef {
  if (annotation === undefined) return { kind: 'missing' };

  const text = annotation.replace(/\s+/g, ' ').trim();
  const inner = /^Promise<(.+)>$/.exec(text)?.[1]?.trim() ?? text;
  if (inner === 'void') return { kind: 'none' };

  const named = /^([A-Z][A-Za-z0-9]*)(\[\])?$/.exec(inner);
  if (named) return { kind: 'type', name: named[1], array: Boolean(named[2]) };
  return { kind: 'unnamed', text: inner };
}

/** The declared return type of every controller method, keyed `Class.method`. */
export function readReturnTypes(srcDir: string): Map<string, ReturnRef> {
  const found = new Map<string, ReturnRef>();
  const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.controller.ts'))
    .sort();

  for (const file of files) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) {
          continue;
        }
        found.set(
          `${node.name.text}.${member.name.text}`,
          refOf(member.type?.getText(source)),
        );
      }
    });
  }
  return found;
}
