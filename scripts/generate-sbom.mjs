import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = process.cwd()
const lockPath = join(root, 'package-lock.json')
let lock
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'))
} catch (error) {
  console.error(`Could not read package-lock.json: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

const rootName = lock.name ?? 'devforge'
const rootVersion = lock.version ?? '0.0.0'
const components = []
const seen = new Set()

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || !entry || entry.link) continue
  const name = entry.name ?? path.replace(/^node_modules\//, '').split('node_modules/').pop()
  if (!name || !entry.version) continue
  const key = `${name}@${entry.version}`
  if (seen.has(key)) continue
  seen.add(key)
  components.push({
    type: 'library',
    name,
    version: entry.version,
    purl: `pkg:npm/${name.replace('/', '%2F')}@${entry.version}`,
    scope: entry.dev ? 'optional' : 'required',
    properties: [
      { name: 'devforge:devDependency', value: entry.dev ? 'true' : 'false' },
      ...(entry.integrity
        ? [{ name: 'devforge:lockIntegrity', value: entry.integrity }]
        : [])
    ]
  })
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'DevForge', name: 'generate-sbom', version: '1.0.0' }],
    component: { type: 'application', name: rootName, version: rootVersion }
  },
  components
}

const outputDir = process.argv[2] ?? process.env.DEVFORGE_OUTPUT_DIR ?? 'dist'
const output = join(root, outputDir, 'sbom.cdx.json')
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(sbom, null, 2), 'utf8')
console.log(`Wrote ${components.length} components to ${output}`)
