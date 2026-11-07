import { z } from 'zod'
import type { EnvironmentManifest, EnvironmentProfile, ProfileInput } from './types'

const manifestComponentSchema = z
  .object({
    packageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(120).nullable(),
    optional: z.boolean().default(false),
    installedVersion: z.string().min(1).max(120).nullable().default(null)
  })
  .strict()

export const environmentManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('devforge-environment'),
    name: z.string().min(2).max(60),
    description: z.string().max(400),
    audience: z.string().max(120),
    icon: z.string().max(60),
    exportedAt: z.string().min(1),
    appVersion: z.string().min(1),
    platform: z.string().min(1),
    components: z.array(manifestComponentSchema).min(1).max(30),
    warnings: z.array(z.string().max(500)).max(20).default([])
  })
  .strict()

export type ParsedEnvironmentManifest = z.infer<typeof environmentManifestSchema>

export function parseEnvironmentManifest(
  input: unknown
):
  | { ok: true; value: EnvironmentManifest }
  | { ok: false; issues: string[] } {
  const parsed = environmentManifestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
  }
  return { ok: true, value: parsed.data as EnvironmentManifest }
}

function uniqueName(base: string, existing: Set<string>): string {
  const normalized = base.trim().slice(0, 60) || 'Imported environment'
  if (!existing.has(normalized.toLowerCase())) return normalized
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${normalized.slice(0, 54)} (${index})`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  return `${normalized.slice(0, 54)} (imported)`
}

/**
 * Converts a manifest into a valid profile input while keeping the exact pinned
 * versions. Existing profile names are never overwritten.
 */
export function manifestToProfileInput(
  manifest: EnvironmentManifest,
  existingProfiles: EnvironmentProfile[]
): { input: ProfileInput; warnings: string[] } {
  const existingNames = new Set(existingProfiles.map((profile) => profile.name.toLowerCase()))
  const warnings = [...manifest.warnings]
  const seen = new Set<string>()
  const components = manifest.components
    .filter((component) => {
      if (seen.has(component.packageId)) {
        warnings.push(`The manifest contains "${component.packageId}" more than once; only the first entry is used.`)
        return false
      }
      seen.add(component.packageId)
      return true
    })
    .map((component) => ({
      packageId: component.packageId,
      optional: component.optional,
      preferredVersion: component.version
    }))

  return {
    input: {
      name: uniqueName(manifest.name, existingNames),
      description: manifest.description || 'An environment imported from a DevForge manifest.',
      audience: manifest.audience || 'Imported environment',
      icon: manifest.icon || 'Layers',
      components
    },
    warnings
  }
}
