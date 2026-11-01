import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_ROOT = "Wrenai/tests/";
const TEST_FILE = /(?:^test[._-]|[._-](?:test|spec|fixture)(?:[._-]|$)|\.snap$)/i;
const TEST_RESOURCE = /(?:^test[._-]|(?:^|[._-])fixture(?:[._-]|$)|\.snap$)/i;
const DOCUMENT_FILE = /\.(?:md|mdx|rst)$/i;
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "mocks",
  "__mocks__",
  "__snapshots__",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".swc",
  ".cache",
  ".codex",
  ".kiro",
  ".agents",
  ".vercel",
  ".vite",
  ".vitest",
  ".pnpm-store",
  ".pnpm-cache",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "data",
]);
const CODE_FILE = /\.[cm]?[jt]sx?$/;

function moduleName(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
  }
  return null;
}

/** Enforces placement without executing source files or mistaking code examples in strings for imports. */
export function testLayoutIssue(file: string, content = ""): string | null {
  const name = posix.normalize(file.replaceAll("\\", "/"));
  if (name.startsWith(TEST_ROOT)) {
    return null;
  }
  const segments = name.split("/");
  const filename = segments.at(-1) ?? "";
  const misplacedFile =
    (CODE_FILE.test(name) && TEST_FILE.test(filename)) ||
    (!DOCUMENT_FILE.test(name) && TEST_RESOURCE.test(filename));
  if (misplacedFile || segments.some((segment) => TEST_DIRECTORIES.has(segment))) {
    return "Test files, helpers and fixtures belong in Wrenai/tests/.";
  }
  if (!CODE_FILE.test(name)) {
    return null;
  }
  let issue: string | null = null;
  const visit = (node: ts.Node): void => {
    const module = moduleName(node);
    if (
      module === "vitest" ||
      (module?.startsWith("vitest/") && module !== "vitest/config") ||
      module === "node:test" ||
      module?.startsWith("@testing-library/") ||
      module === "@playwright/test" ||
      module === "@electric-sql/pglite" ||
      module?.startsWith("@electric-sql/pglite/")
    ) {
      issue = "Files importing test-only libraries belong in Wrenai/tests/.";
    }
    if (
      module?.startsWith("@tests/") ||
      (module?.startsWith(".") &&
        posix.normalize(posix.join(posix.dirname(name), module)).startsWith(TEST_ROOT))
    ) {
      issue = "Application code cannot import test helpers or fixtures.";
    }
    if (issue === null) {
      ts.forEachChild(node, visit);
    }
  };
  visit(ts.createSourceFile(name, content, ts.ScriptTarget.Latest));
  return issue;
}

/** Both lint and direct Vitest runs enforce the same workspace-wide boundary. */
export async function checkTestLayout(): Promise<void> {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const violations: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const name = relative(workspace, absolute).split(sep).join("/");
      if (name === TEST_ROOT.slice(0, -1) || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) {
        continue;
      }
      if (entry.isDirectory()) {
        const issue = TEST_DIRECTORIES.has(entry.name) ? testLayoutIssue(`${name}/`) : null;
        if (issue) {
          violations.push(`${name}: ${issue}`);
        } else {
          await walk(absolute);
        }
      } else if (entry.isFile()) {
        const content = CODE_FILE.test(name) ? await readFile(absolute, "utf8") : "";
        const issue = testLayoutIssue(name, content);
        if (issue) {
          violations.push(`${name}: ${issue}`);
        }
      }
    }
  }
  await walk(workspace);
  if (violations.length > 0) {
    throw new Error(`Test directory rule violated:\n${violations.sort().join("\n")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkTestLayout();
}
