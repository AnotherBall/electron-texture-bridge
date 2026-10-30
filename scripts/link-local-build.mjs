#!/usr/bin/env node
// Overlays a local electron-texture-bridge build into an app's node_modules (no package.json / lockfile change),
// for trying unpublished changes in an app that uses the @anotherball/* packages (e.g. Avvy Studio).
// Usage:
//   node scripts/link-local-build.mjs <texture-bridge dir> <app dir>   # build first: pnpm build:native && pnpm build:core
//   node scripts/link-local-build.mjs --restore <app dir>              # put the *.orig backups back
// The first overlay keeps each replaced file as <file>.orig (and records files it added), so --restore undoes it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const MANIFEST = '.local-texture-bridge-added.json'
const args = process.argv.slice(2)

if (args[0] === '--restore') {
  if (!args[1]) usage()
  restore(resolve(args[1]))
} else {
  if (args.length !== 2) usage()
  link(resolve(args[0]), resolve(args[1]))
}

function usage() {
  console.error('usage: link-local-build.mjs <texture-bridge dir> <app dir>\n       link-local-build.mjs --restore <app dir>')
  process.exit(2)
}

function scope(app) {
  return join(app, 'node_modules', '@anotherball')
}

function link(bridge, app) {
  const target = scope(app)
  if (!existsSync(join(target, 'texture-bridge-core'))) throw new Error(`${target} has no texture-bridge-core: run npm ci first`)
  const native = join(bridge, 'packages', 'native')
  const coreDist = join(bridge, 'packages', 'core', 'dist')
  const added = readAdded(app)
  const triple = platformTriple()
  const files = [
    [join(native, `index.${triple}.node`), join(target, `texture-bridge-${triple}`, `index.${triple}.node`), false],
    [join(native, 'index.js'), join(target, 'texture-bridge', 'index.js'), true],
    [join(native, 'index.d.ts'), join(target, 'texture-bridge', 'index.d.ts'), true],
    ...walk(coreDist).map((file) => [file, join(target, 'texture-bridge-core', 'dist', relative(coreDist, file)), true])
  ]
  for (const [from, to, rewrite] of files) {
    if (!existsSync(from)) throw new Error(`missing ${from}: build texture-bridge first`)
    if (existsSync(to)) {
      if (!existsSync(`${to}.orig`) && !added.includes(to)) copyFileSync(to, `${to}.orig`)
    } else if (!added.includes(to)) {
      added.push(to)
    }
    mkdirSync(dirname(to), { recursive: true })
    if (rewrite) writeFileSync(to, readFileSync(from, 'utf8').replaceAll('@napolab/', '@anotherball/'))
    else copyFileSync(from, to)
    console.log(`linked ${relative(app, to)}`)
  }
  writeFileSync(join(target, MANIFEST), JSON.stringify(added, null, 2))
}

// napi-rs's platform suffix for this machine (the native package's name and .node file).
function platformTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc'
  if (process.platform === 'darwin') return `darwin-${process.arch}`
  throw new Error(`unsupported platform ${process.platform}-${process.arch}`)
}

function restore(app) {
  const target = scope(app)
  let restored = 0
  for (const file of walk(target).filter((path) => path.endsWith('.orig'))) {
    renameSync(file, file.slice(0, -'.orig'.length))
    restored += 1
  }
  for (const file of readAdded(app)) {
    rmSync(file, { force: true })
    restored += 1
  }
  rmSync(join(target, MANIFEST), { force: true })
  console.log(`restored ${restored} file(s)`)
}

function readAdded(app) {
  const path = join(scope(app), MANIFEST)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
