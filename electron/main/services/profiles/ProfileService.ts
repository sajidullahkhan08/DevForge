import type { EnvironmentManifest, EnvironmentProfile, ProfileInput } from '@shared/types'
import { manifestToProfileInput, parseEnvironmentManifest } from '@shared/manifest'
import type { AppDatabase } from '../database/Database'
import { AppError } from '../errors'
import type { Logger } from '../logging/Logger'
import type { RegistryService } from '../registry/RegistryService'

function validateInput(input: ProfileInput, registry: RegistryService): ProfileInput {
  if (!input || typeof input !== 'object') {
    throw new AppError('VALIDATION', 'The environment profile is not valid.')
  }
  const name = String(input.name ?? '').trim()
  if (name.length < 2 || name.length > 60) {
    throw new AppError('VALIDATION', 'Profile names must be between 2 and 60 characters.')
  }
  const description = String(input.description ?? '').trim()
  if (description.length > 400) {
    throw new AppError('VALIDATION', 'Profile descriptions cannot exceed 400 characters.')
  }
  const audience = String(input.audience ?? '').trim().slice(0, 120)
  const icon = String(input.icon ?? 'Layers').trim().slice(0, 60) || 'Layers'
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new AppError('VALIDATION', 'Add at least one package to the profile.')
  }
  if (input.components.length > 30) {
    throw new AppError('VALIDATION', 'A profile can contain at most 30 packages.')
  }
  const seen = new Set<string>()
  const components = input.components.map((component) => {
    const packageId = String(component.packageId ?? '')
    if (!registry.hasPackage(packageId)) {
      throw new AppError('VALIDATION', `"${packageId}" is not a DevForge package.`)
    }
    if (seen.has(packageId)) {
      throw new AppError('VALIDATION', 'A package can only appear once in a profile.')
    }
    seen.add(packageId)
    return {
      packageId,
      optional: Boolean(component.optional),
      preferredVersion: component.preferredVersion ? String(component.preferredVersion) : null
    }
  })
  return {
    name,
    description: description || 'A custom DevForge development environment.',
    audience: audience || 'Custom environment',
    icon,
    components
  }
}

export class ProfileService {
  constructor(
    private readonly db: AppDatabase,
    private readonly registry: RegistryService,
    private readonly logger: Logger
  ) {}

  list(): EnvironmentProfile[] {
    return this.db.listProfiles()
  }

  create(input: ProfileInput): EnvironmentProfile {
    const validated = validateInput(input, this.registry)
    const profile = this.db.createProfile(validated)
    this.logger.info('Custom profile created', { id: profile.id, packages: profile.components.length })
    return profile
  }

  update(profileId: string, input: ProfileInput): EnvironmentProfile {
    const validated = validateInput(input, this.registry)
    const profile = this.db.updateProfile(profileId, validated)
    this.logger.info('Custom profile updated', { id: profile.id })
    return profile
  }

  remove(profileId: string): void {
    this.db.deleteProfile(profileId)
    this.logger.info('Custom profile removed', { id: profileId })
  }

  duplicate(profileId: string): EnvironmentProfile {
    const profile = this.list().find((candidate) => candidate.id === profileId)
    if (!profile) throw new AppError('NOT_FOUND', 'That environment profile was not found.')
    return this.create({
      name: `${profile.name} copy`.slice(0, 60),
      description: profile.description,
      audience: profile.audience,
      icon: profile.icon,
      components: profile.components.map((component) => ({
        packageId: component.packageId,
        optional: component.optional,
        preferredVersion: component.preferredVersion
      }))
    })
  }

  /**
   * Produces a portable manifest with exact installed versions. The manifest is
   * metadata only: importing it creates a profile and never installs anything
   * until the user reviews a plan.
   */
  exportManifest(profileId: string, appVersion: string): EnvironmentManifest {
    const profile = this.list().find((candidate) => candidate.id === profileId)
    if (!profile) throw new AppError('NOT_FOUND', 'That environment profile was not found.')

    const installations = this.db
      .listInstallations()
      .filter((record) => record.status === 'installed')
    const warnings: string[] = []
    const components = profile.components.map((component) => {
      const pkg = this.registry.getPackage(component.packageId)
      const records = installations.filter((record) => record.packageId === component.packageId)
      const active =
        records.find((record) => record.isActive) ??
        records.sort((left, right) => (left.installedAt < right.installedAt ? 1 : -1))[0] ??
        null
      const fallbackVersion =
        pkg?.versions.find((version) => version.isDefault)?.version ??
        pkg?.versions[0]?.version ??
        null
      const version = component.preferredVersion ?? fallbackVersion
      if (!version) {
        warnings.push(`${pkg?.name ?? component.packageId} has no version to pin.`)
      }
      if (pkg && component.preferredVersion && !pkg.versions.some((entry) => entry.version === component.preferredVersion)) {
        warnings.push(
          `${pkg.name} does not list version ${component.preferredVersion}; the manifest keeps it as a preference.`
        )
      }
      return {
        packageId: component.packageId,
        name: pkg?.name ?? component.packageId,
        version,
        optional: component.optional,
        installedVersion: active?.detectedVersion ?? active?.version ?? null
      }
    })

    return {
      schemaVersion: 2,
      kind: 'devforge-environment',
      name: profile.name,
      description: profile.description,
      audience: profile.audience,
      icon: profile.icon,
      exportedAt: new Date().toISOString(),
      appVersion,
      platform: process.platform,
      components,
      warnings
    }
  }

  importManifest(input: unknown): { profile: EnvironmentProfile; warnings: string[] } {
    const parsed = parseEnvironmentManifest(input)
    if (!parsed.ok) {
      throw new AppError('VALIDATION', 'The environment manifest is not valid.', {
        hint: 'Choose a manifest exported by DevForge 1.0 or later.',
        details: parsed.issues.slice(0, 8).join('\n')
      })
    }

    const warnings = [...parsed.value.warnings]
    const known = parsed.value.components.filter((component) => {
      if (!this.registry.hasPackage(component.packageId)) {
        warnings.push(`Skipped "${component.name}" because that package is not available in this DevForge catalogue.`)
        return false
      }
      return true
    })
    if (known.length === 0) {
      throw new AppError('VALIDATION', 'None of the packages in this manifest are available in the DevForge catalogue.')
    }

    const { input: profileInput, warnings: conversionWarnings } = manifestToProfileInput(
      { ...parsed.value, components: known },
      this.list()
    )
    warnings.push(...conversionWarnings)
    const profile = this.create(profileInput)
    this.logger.info('Environment manifest imported', {
      id: profile.id,
      components: profile.components.length,
      warnings: warnings.length
    })
    return { profile, warnings }
  }
}
