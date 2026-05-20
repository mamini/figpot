import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const loaderDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(loaderDirectory, '..');

function resolveAliasPath(specifier) {
  const basePath = path.join(projectRoot, specifier.replace(/^@figpot\//, ''));
  const normalizedBasePaths = [basePath];

  if (/\.(?:c|m)?js$/i.test(basePath)) {
    normalizedBasePaths.push(basePath.replace(/\.(?:c|m)?js$/i, '.ts'));
    normalizedBasePaths.push(basePath.replace(/\.(?:c|m)?js$/i, '.tsx'));
  }

  const candidatePaths = [
    ...normalizedBasePaths,
    ...normalizedBasePaths.flatMap((normalizedBasePath) => [
      `${normalizedBasePath}.ts`,
      `${normalizedBasePath}.tsx`,
      `${normalizedBasePath}.js`,
      `${normalizedBasePath}.mjs`,
      `${normalizedBasePath}.json`,
      path.join(normalizedBasePath, 'index.ts'),
      path.join(normalizedBasePath, 'index.tsx'),
      path.join(normalizedBasePath, 'index.js'),
      path.join(normalizedBasePath, 'index.mjs'),
      path.join(normalizedBasePath, 'index.json'),
    ]),
  ];

  return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@figpot/')) {
    return nextResolve(specifier, context);
  }

  const resolvedPath = resolveAliasPath(specifier);

  if (!resolvedPath) {
    throw new Error(`Unable to resolve figpot alias: ${specifier}`);
  }

  return nextResolve(pathToFileURL(resolvedPath).href, context);
}