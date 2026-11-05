// Resolve hook: lets Node load the Cockpit engine's extensionless TypeScript imports
// ('./swarm', '../types') unchanged. Only relative specifiers from file: parents are touched.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    for (const ext of ['.ts', '/index.ts', '.d.ts']) {
      const url = new URL(specifier + ext, context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
  }
  return next(specifier, context)
}
