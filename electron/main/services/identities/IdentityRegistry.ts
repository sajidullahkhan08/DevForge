import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalIdentity, IdentityValidationIssue } from '@shared/identity'
import {
  identityRegistryFileSchema,
  normalizeSoftwareText,
  scoreTextMatch,
  validateIdentity,
  validateIdentitySemantics
} from '@shared/identity'
import type { PackageDefinition } from '@shared/registry'
import { managerIdForPackage } from '@shared/winget'
import type { Logger } from '../logging/Logger'
import type { RegistryService } from '../registry/RegistryService'

/**
 * Loads the canonical software identities. Identities are independent of any
 * package source: a curated package, a WinGet manifest and an official release
 * feed can all point at the same stable identity.
 */
export class IdentityRegistry {
  private readonly identities = new Map<string, CanonicalIdentity>()
  private readonly issues: IdentityValidationIssue[] = []

  constructor(
    private readonly rootDir: string,
    private readonly registry: RegistryService,
    private readonly logger: Logger
  ) {
    this.load()
  }

  private load(): void {
    const filePath = join(this.rootDir, 'identities.json')
    if (!existsSync(filePath)) {
      this.issues.push({
        file: 'identities.json',
        path: '(root)',
        message: 'The canonical identity registry is missing'
      })
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      this.issues.push({
        file: 'identities.json',
        path: '(root)',
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      })
      return
    }

    const parsed = identityRegistryFileSchema.safeParse(raw)
    if (!parsed.success) {
      this.issues.push({
        file: 'identities.json',
        path: '(root)',
        message: parsed.error.issues[0]?.message ?? 'Unsupported identity registry format'
      })
      return
    }

    parsed.data.identities.forEach((input, index) => {
      const label = `identities.json:identities[${index}]`
      const result = validateIdentity(input, label)
      if (!result.ok) {
        this.issues.push(...result.issues)
        return
      }
      const identity = result.value
      if (this.identities.has(identity.id)) {
        this.issues.push({
          file: label,
          path: 'id',
          message: `Duplicate identity id "${identity.id}"`
        })
        return
      }
      const semantic = validateIdentitySemantics(identity)
      if (semantic.length > 0) {
        this.issues.push(...semantic)
        return
      }
      for (const packageId of identity.packageIds) {
        if (!this.registry.hasPackage(packageId)) {
          this.issues.push({
            file: label,
            path: 'packageIds',
            message: `Unknown package "${packageId}"`
          })
        }
      }
      this.identities.set(identity.id, identity)
    })

    if (this.issues.length > 0) {
      this.logger.warn('Identity registry validation issues', {
        issues: this.issues,
        loaded: this.identities.size
      })
    }
    this.registry.addIssues(
      this.issues.map((issue) => ({ file: issue.file, path: issue.path, message: issue.message }))
    )
  }

  list(): CanonicalIdentity[] {
    return [...this.identities.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  get(id: string): CanonicalIdentity | null {
    return this.identities.get(id) ?? null
  }

  /**
   * Finds the identity that backs a package. Identifiers are authoritative; an
   * exact display-name match is only trusted when the publisher agrees.
   */
  forPackage(pkg: PackageDefinition): CanonicalIdentity | null {
    const packageId = pkg.id.toLowerCase()
    const managerId = managerIdForPackage(pkg)?.toLowerCase() ?? null

    for (const identity of this.identities.values()) {
      if (identity.id === packageId) return identity
      if (identity.packageIds.some((id) => id.toLowerCase() === packageId)) return identity
      if (managerId && identity.wingetIds.some((id) => id.toLowerCase() === managerId)) {
        return identity
      }
    }

    const publisher = normalizeSoftwareText(pkg.publisher ?? '')
    if (!publisher) return null
    for (const identity of this.identities.values()) {
      const identityPublisher = normalizeSoftwareText(identity.publisher)
      const publisherMatches =
        identityPublisher.length >= 3 &&
        (publisher.includes(identityPublisher) || identityPublisher.includes(publisher))
      if (scoreTextMatch(identity.name, pkg.name) >= 98 && publisherMatches) return identity
    }
    return null
  }

  getIssues(): IdentityValidationIssue[] {
    return [...this.issues]
  }
}
