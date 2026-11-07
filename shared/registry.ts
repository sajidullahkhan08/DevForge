import { z } from 'zod'

export const packageCategories = [
  'language',
  'framework',
  'database',
  'compiler',
  'build-tool',
  'developer-tool',
  'runtime'
] as const

export const installationMethods = [
  'winget',
  'official-installer',
  'archive',
  'project-recipe'
] as const

const httpsUrl = z
  .string()
  .regex(/^https:\/\/[^\s]+$/, 'Must be a valid HTTPS URL')

const versionString = z
  .string()
  .regex(/^\d+(\.\d+){0,3}([-+][A-Za-z0-9.]+)?$/, 'Unsupported version format')

const checksumSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64,128}$/, 'Checksum must be a hex SHA-256 or SHA-512 digest')

export const dependencySchema = z.object({
  packageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(['required', 'optional']).default('required'),
  minVersion: versionString.optional(),
  reason: z.string().min(1).optional()
})

export const downloadSchema = z.object({
  url: httpsUrl,
  archiveType: z.enum(['zip']).optional(),
  checksum: checksumSchema,
  checksumAlgorithm: z.enum(['sha256', 'sha512']).default('sha256'),
  sizeBytes: z.number().int().positive().optional(),
  stripRootFolder: z.boolean().default(true),
  /**
   * Optional Authenticode pinning for executables. When present, DevForge
   * verifies the downloaded file's signature before running it.
   */
  signature: z
    .object({
      publisher: z.string().min(1),
      thumbprint: z
        .string()
        .regex(/^[A-Fa-f0-9]{40,64}$/, 'Thumbprint must be a SHA-1 or SHA-256 certificate thumbprint')
        .optional()
    })
    .strict()
    .optional()
})

export const registryVersionSchema = z.object({
  version: versionString,
  channel: z.enum(['stable', 'lts']).default('stable'),
  isDefault: z.boolean().default(false),
  packageManagerId: z.string().min(1).optional(),
  download: downloadSchema.optional(),
  installArgs: z.array(z.string()).default([]),
  estimatedSizeBytes: z.number().int().positive().optional()
})

export const environmentSpecSchema = z.object({
  kind: z.enum(['path', 'variable']),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/),
  valueTemplate: z.string().min(1),
  scope: z.enum(['user', 'system']).default('user')
})

export const verificationSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['command', 'service', 'file', 'winget']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  expectPattern: z.string().optional(),
  versionPattern: z.string().optional(),
  serviceNamePattern: z.string().optional(),
  filePathTemplate: z.string().optional(),
  optional: z.boolean().default(false)
})

export const detectionSpecSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  versionPattern: z.string().optional(),
  displayNamePattern: z.string().optional(),
  knownPaths: z.array(z.string()).default([]),
  serviceNamePattern: z.string().optional()
})

export const projectRecipeSchema = z.object({
  summary: z.string().min(1),
  commands: z
    .array(
      z.object({
        label: z.string().min(1),
        command: z.string().min(1)
      })
    )
    .default([]),
  notes: z.array(z.string()).default([])
})

export const packageDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(packageCategories),
  origin: z.enum(['registry', 'winget', 'official']).optional(),
  description: z.string().min(1),
  longDescription: z.string().optional(),
  publisher: z.string().min(1),
  homepage: httpsUrl,
  documentationUrl: httpsUrl.optional(),
  license: z.string().min(1),
  icon: z.string().min(1),
  installationMethod: z.enum(installationMethods),
  packageManagerId: z.string().min(1).optional(),
  scope: z.enum(['user', 'system']).default('user'),
  supportedArchitectures: z.array(z.enum(['x64', 'arm64'])).default(['x64']),
  supportedWindowsVersions: z.array(z.string()).default(['10', '11']),
  requiresAdmin: z.boolean().default(false),
  requiresRestart: z.boolean().default(false),
  advanced: z.boolean().default(false),
  caveats: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  installDirectoryTemplate: z.string().optional(),
  expectedExecutables: z.array(z.string()).default([]),
  supportsVersionSwitching: z.boolean().default(false),
  versions: z.array(registryVersionSchema).default([]),
  dependencies: z.array(dependencySchema).default([]),
  environment: z.array(environmentSpecSchema).default([]),
  verification: z.array(verificationSpecSchema).default([]),
  detection: detectionSpecSchema.default({ args: [], knownPaths: [] }),
  uninstall: z
    .object({
      method: z.enum(['winget', 'directory', 'command']),
      command: z.string().min(1).optional(),
      args: z.array(z.string()).default([]),
      keepData: z.boolean().default(true)
    })
    .optional(),
  projectRecipe: projectRecipeSchema.optional()
})

export const profileComponentSchema = z.object({
  packageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  optional: z.boolean().default(false),
  preferredVersion: versionString.optional()
})

export const profileDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  audience: z.string().min(1),
  icon: z.string().min(1),
  notes: z.array(z.string()).default([]),
  components: z.array(profileComponentSchema).min(1)
})

export type PackageCategory = (typeof packageCategories)[number]
export type InstallationMethod = (typeof installationMethods)[number]
export type DependencyDefinition = z.infer<typeof dependencySchema>
export type DownloadDefinition = z.infer<typeof downloadSchema>
export type RegistryVersion = z.infer<typeof registryVersionSchema>
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>
export type VerificationSpec = z.infer<typeof verificationSpecSchema>
export type DetectionSpec = z.infer<typeof detectionSpecSchema>
export type ProjectRecipe = z.infer<typeof projectRecipeSchema>
export type PackageDefinition = z.infer<typeof packageDefinitionSchema>
export type ProfileDefinition = z.infer<typeof profileDefinitionSchema>
export type ProfileComponentDefinition = z.infer<typeof profileComponentSchema>

export interface ValidationIssue {
  file: string
  path: string
  message: string
}

export function validatePackageDefinition(input: unknown, file = 'unknown'):
  | { ok: true; value: PackageDefinition }
  | { ok: false; issues: ValidationIssue[] } {
  const parsed = packageDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        file,
        path: issue.path.join('.') || '(root)',
        message: issue.message
      }))
    }
  }
  return { ok: true, value: parsed.data }
}

export function validateProfileDefinition(input: unknown, file = 'unknown'):
  | { ok: true; value: ProfileDefinition }
  | { ok: false; issues: ValidationIssue[] } {
  const parsed = profileDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        file,
        path: issue.path.join('.') || '(root)',
        message: issue.message
      }))
    }
  }
  return { ok: true, value: parsed.data }
}

/**
 * Cross-field validation that cannot be expressed in a single object schema.
 */
export function validatePackageSemantics(pkg: PackageDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()

  for (const version of pkg.versions) {
    if (seen.has(version.version)) {
      issues.push({
        file: pkg.id,
        path: 'versions',
        message: `Duplicate version "${version.version}"`
      })
    }
    seen.add(version.version)

    if (pkg.installationMethod === 'archive' && !version.download) {
      issues.push({
        file: pkg.id,
        path: `versions.${version.version}.download`,
        message: 'Archive packages must define download metadata for every version'
      })
    }
    if (pkg.installationMethod === 'winget' && !version.packageManagerId && !pkg.packageManagerId) {
      issues.push({
        file: pkg.id,
        path: `versions.${version.version}.packageManagerId`,
        message: 'WinGet packages must define a package manager id'
      })
    }
  }

  if (pkg.installationMethod !== 'project-recipe' && pkg.versions.length === 0) {
    issues.push({
      file: pkg.id,
      path: 'versions',
      message: 'Installable packages must declare at least one version'
    })
  }

  if (pkg.versions.length > 0) {
    const defaults = pkg.versions.filter((version) => version.isDefault)
    if (defaults.length !== 1) {
      issues.push({
        file: pkg.id,
        path: 'versions',
        message: 'Exactly one version must be marked as the default version'
      })
    }
  }

  if (pkg.installationMethod === 'project-recipe' && !pkg.projectRecipe) {
    issues.push({
      file: pkg.id,
      path: 'projectRecipe',
      message: 'Project recipes must include setup instructions'
    })
  }

  if (pkg.installationMethod === 'archive' && pkg.expectedExecutables.length === 0) {
    issues.push({
      file: pkg.id,
      path: 'expectedExecutables',
      message: 'Archive packages should declare at least one expected executable'
    })
  }

  for (const dependency of pkg.dependencies) {
    if (dependency.packageId === pkg.id) {
      issues.push({
        file: pkg.id,
        path: 'dependencies',
        message: 'A package cannot depend on itself'
      })
    }
  }

  return issues
}
