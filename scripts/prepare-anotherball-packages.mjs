import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const version = process.argv[2]
if (!version) {
  throw new Error('Usage: node scripts/prepare-anotherball-packages.mjs <version>')
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`)
}

const root = resolve(import.meta.dirname, '..')
const packageNames = {
  '@napolab/texture-bridge': '@anotherball/texture-bridge',
  '@napolab/texture-bridge-core': '@anotherball/texture-bridge-core',
  '@napolab/texture-bridge-renderer': '@anotherball/texture-bridge-renderer',
  '@napolab/texture-bridge-example': '@anotherball/texture-bridge-example'
}

const manifestPaths = [
  'packages/native/package.json',
  'packages/core/package.json',
  'packages/renderer/package.json',
  'packages/example/package.json'
]

for (const relativePath of manifestPaths) {
  const path = resolve(root, relativePath)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.name = packageNames[manifest.name] ?? manifest.name

  if (!manifest.private) {
    manifest.version = version
    manifest.publishConfig = {
      ...(manifest.publishConfig ?? {}),
      registry: 'https://npm.pkg.github.com'
    }
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (!manifest[field]) continue
    manifest[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, value]) => [
        packageNames[name] ?? name,
        value
      ])
    )
  }

  if (manifest.napi?.package?.name) {
    manifest.napi.package.name =
      packageNames[manifest.napi.package.name] ?? manifest.napi.package.name
  }

  if (manifest.repository?.url) {
    manifest.repository.url =
      'https://github.com/AnotherBall/electron-texture-bridge'
  }

  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

const sourcePaths = [
  'packages/core/src/index.ts',
  'packages/renderer/src/bridge.ts',
  'packages/renderer/src/discovery.ts',
  'packages/renderer/src/receiver.ts',
  'packages/renderer/src/shared-texture-receiver.ts'
]

for (const relativePath of sourcePaths) {
  const path = resolve(root, relativePath)
  let source = await readFile(path, 'utf8')
  for (const [upstreamName, forkName] of Object.entries(packageNames)) {
    source = source.replaceAll(upstreamName, forkName)
  }
  await writeFile(path, source)
}

console.log(`Prepared @anotherball texture-bridge packages at ${version}`)
