/**
 * EC1 -- dependency isolation.
 *
 * The extension's durability claim (RQ1) rests on it never importing a
 * Cornerstone3D or OHIF-core symbol directly. Previously this was checked
 * by hand once, with no record and nothing to catch a regression. This
 * walks every production source file and asserts the import boundary
 * holds. __tests__ itself is excluded: test files legitimately name
 * '@cornerstonejs/core' as a string to jest.doMock it, which is not an
 * import and not a boundary violation.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_PREFIXES = [/^@cornerstonejs\//, /^@ohif\//];
const IMPORT_SPECIFIER_RE =
  /\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function listProductionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProductionSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('dependency isolation (EC1)', () => {
  it('imports no symbol from @cornerstonejs/* or @ohif/* anywhere in production source', () => {
    const violations: string[] = [];
    for (const file of listProductionSourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      IMPORT_SPECIFIER_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT_SPECIFIER_RE.exec(text))) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (FORBIDDEN_PREFIXES.some((re) => re.test(specifier))) {
          violations.push(`${path.relative(SRC_ROOT, file)}: '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
