import type { PackageCategory, PackageDefinition } from '@shared/registry'
import type { InstalledSummary } from '@shared/types'

export interface ProviderDiscoveryResult {
  /** Stable provider-scoped id used when preparing a validated package. */
  id: string
  source: 'winget'
  sourceLabel: string
  /** WinGet manifest identifier, when the source is a package manager. */
  managerId: string | null
  name: string
  publisher: string
  description: string
  version: string | null
  category: PackageCategory
  homepage: string | null
  license: string | null
  tags: string[]
  icon: string
  compatibility: 'installable' | 'metadata-only'
  compatibilityNote: string | null
  packageId: string | null
  installedVersion: string | null
  updateAvailable: boolean
  verified: boolean
  metadataUrl: string | null
}

export interface DiscoveryProviderContext {
  knownPackages: PackageDefinition[]
  installations: InstalledSummary[]
}

export interface DiscoveryProviderOutcome {
  results: ProviderDiscoveryResult[]
  candidates: Map<string, PackageDefinition>
  report: import('@shared/discovery').DiscoveryProviderReport
}

export interface DiscoveryProvider {
  readonly id: string
  readonly label: string
  search(query: string, context: DiscoveryProviderContext): Promise<DiscoveryProviderOutcome>
}
