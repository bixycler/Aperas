// The engine's boundary (design/core.md, "The boundary"): the files of `core/src/apeironNgn/` import only files
// inside that directory. No `node:` module, no package at all, and so nothing of the shell, no file system and no
// store library. The checker reads each file with the TypeScript parser, so a specifier in a comment or a string
// is not taken for an import, and it covers `import`, `import type`, `export ... from`, a bare `import 'x'`,
// `import x = require('x')`, a dynamic `import()` (also in a type), and `require`. A dynamic `import()` or
// `require` whose argument is not a string literal cannot be checked and is refused. Because the directory is
// clean, the checker is first proved on inline sources, one for each banned form and one clean.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ENGINE_DIR = resolve(fileURLToPath(new URL('../../../../core/src/apeironNgn/', import.meta.url)));

/** Every module specifier a source names, with `null` for a dynamic import or require whose argument is not a string literal. */
function specifiersOf(source: string): (string | null)[] {
  const out: (string | null)[] = [];
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literal = (node: ts.Node | undefined): string | null => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) out.push(literal(node.moduleSpecifier));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) out.push(literal(node.moduleSpecifier));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) out.push(literal(node.moduleReference.expression));
    else if (ts.isImportTypeNode(node)) out.push(ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : null);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) out.push(literal(node.arguments[0]));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The violations of the boundary in a source that stands at `path`. */
function violationsOf(source: string, path: string): string[] {
  const found: string[] = [];
  for (const spec of specifiersOf(source)) {
    if (spec === null) { found.push('a dynamic import or require whose argument is not a string literal'); continue; }
    if (!(spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../'))) { found.push(`${spec}: a module or package, and only files inside the directory may be imported`); continue; }
    const to = relative(ENGINE_DIR, resolve(dirname(path), spec));
    if (to === '..' || to.startsWith(`..${sep}`) || isAbsolute(to)) found.push(`${spec}: leaves the engine's directory`);
  }
  return found;
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const AT = join(ENGINE_DIR, 'probe.ts');
const NESTED = join(ENGINE_DIR, 'sub', 'probe.ts');

describe('the engine imports only files inside its directory', () => {
  const banned: [string, string][] = [
    ['node:fs', "import { readFileSync } from 'node:fs';"],
    ['fs', "import fs from 'fs';"],
    ['node:fs/promises', "import { readFile } from 'node:fs/promises';"],
    ['fs/promises', "import { readFile } from 'fs/promises';"],
    ['another node: module', "import { join } from 'node:path';"],
    ['oxigraph', "import { Store } from 'oxigraph';"],
    ['another package', "import { namedNode } from '@rdfjs/data-model';"],
    ['the shell, relative', "import { wrap } from '../shell/node.ts';"],
    ['a file beside the directory', "import { generateNodeId } from '../snowflake';"],
    ['the package form', "import { wrap } from '@aperas/core/shell/node';"],
    ['the package form of a sibling', "import { x } from '@aperas/core/snowflake';"],
    ['a type-only import', "import type { BlockNode } from '../shell/node.ts';"],
    ['an export from', "export { wrap } from '../shell/node.ts';"],
    ['an export star from', "export * from 'oxigraph';"],
    ['a bare import', "import 'oxigraph';"],
    ['a dynamic import', "const m = await import('node:fs');"],
    ['a require', "const fs = require('fs');"],
    ['an import equals require', "import fs = require('fs');"],
    ['an import() in a type', "type S = typeof import('oxigraph');"],
    ['a dynamic import of an expression', 'const m = await import(name);'],
    ['a require of an expression', 'const m = require(name);'],
  ];
  for (const [name, source] of banned) {
    test(`refuses ${name}`, () => {
      assert.equal(violationsOf(source, AT).length, 1, `${source} -> ${JSON.stringify(violationsOf(source, AT))}`);
    });
  }

  test('refuses a file that leaves the directory from a nested one', () => {
    assert.equal(violationsOf("import { x } from '../../shell/node.ts';", NESTED).length, 1);
    assert.equal(violationsOf("import { x } from '../../../snowflake.ts';", NESTED).length, 1);
  });

  test('accepts the files inside the directory', () => {
    const clean = [
      "import { a } from './a.ts';",
      "import type { B } from './sub/b.ts';",
      "export { c } from './c.ts';",
      "export * from './d';",
      "import './e.ts';",
      "const lazy = await import('./f.ts');",
      "// import fs from 'node:fs'; and a string: \"require('fs')\"",
      "const text = \"import x from 'oxigraph'\";",
    ].join('\n');
    assert.deepEqual(violationsOf(clean, AT), []);
    assert.deepEqual(violationsOf("import { a } from '../a.ts'; import { b } from './b.ts';", NESTED), []);
  });

  test('the files of the directory', () => {
    const files = tsFilesUnder(ENGINE_DIR);
    assert.ok(files.length > 0, `${ENGINE_DIR} holds no .ts file`);
    const bad = files.flatMap((file) => violationsOf(readFileSync(file, 'utf8'), file).map((v) => `${relative(ENGINE_DIR, file)}: ${v}`));
    assert.deepEqual(bad, []);
  });
});
