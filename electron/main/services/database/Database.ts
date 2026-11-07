import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AppSettings,
  EnvBackup,
  EnvScope,
  InstalledSummary,
  InstallationMethod,
  LogEntry,
  ProfileComponent,
  ProfileInput,
  QueueStage,
  TransactionDetail,
  TransactionRecord,
  VerificationCheck,
  VerificationRun,
  ActivityEntry,
  EnvironmentProfile
} from '@shared/types'
import type { PackageDefinition, ProfileDefinition } from '@shared/registry'

interface Migration {
  version: number
  name: string
  sql: string
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE packages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        publisher TEXT NOT NULL,
        homepage TEXT NOT NULL,
        documentation_url TEXT,
        license TEXT NOT NULL,
        icon TEXT NOT NULL,
        installation_method TEXT NOT NULL,
        package_manager_id TEXT,
        scope TEXT NOT NULL,
        requires_admin INTEGER NOT NULL DEFAULT 0,
        requires_restart INTEGER NOT NULL DEFAULT 0,
        advanced INTEGER NOT NULL DEFAULT 0,
        supports_version_switching INTEGER NOT NULL DEFAULT 0,
        detection_command TEXT,
        detection_version_pattern TEXT,
        detection_display_name_pattern TEXT,
        detection_service_pattern TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE package_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'stable',
        is_default INTEGER NOT NULL DEFAULT 0,
        package_manager_id TEXT,
        download_url TEXT,
        archive_type TEXT,
        checksum TEXT,
        checksum_algorithm TEXT,
        size_bytes INTEGER,
        install_args_json TEXT,
        estimated_size_bytes INTEGER,
        UNIQUE(package_id, version)
      );
      CREATE INDEX idx_package_versions_package ON package_versions(package_id);

      CREATE TABLE package_dependencies (
        package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        dependency_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        min_version TEXT,
        reason TEXT,
        PRIMARY KEY(package_id, dependency_id, kind)
      );

      CREATE TABLE package_environment_specs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        value_template TEXT NOT NULL,
        scope TEXT NOT NULL
      );
      CREATE INDEX idx_package_env_package ON package_environment_specs(package_id);

      CREATE TABLE package_verification_specs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        spec_id TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        command TEXT,
        args_json TEXT,
        expect_pattern TEXT,
        version_pattern TEXT,
        service_name_pattern TEXT,
        file_path_template TEXT,
        optional INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_package_verification_package ON package_verification_specs(package_id);

      CREATE TABLE package_detection_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        path_template TEXT NOT NULL
      );

      CREATE TABLE installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        method TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'devforge',
        install_dir TEXT,
        status TEXT NOT NULL DEFAULT 'installed',
        verification_status TEXT NOT NULL DEFAULT 'unknown',
        detected_version TEXT,
        available_version TEXT,
        env_status TEXT NOT NULL DEFAULT 'unknown',
        is_active INTEGER NOT NULL DEFAULT 0,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_installations_package ON installations(package_id);
      CREATE INDEX idx_installations_status ON installations(status);

      CREATE TABLE installation_transactions (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        version TEXT,
        method TEXT NOT NULL,
        installation_id INTEGER,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        verification_run_id INTEGER
      );
      CREATE INDEX idx_transactions_started ON installation_transactions(started_at DESC);
      CREATE INDEX idx_transactions_package ON installation_transactions(package_id);

      CREATE TABLE installation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL REFERENCES installation_transactions(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        command TEXT,
        args_json TEXT,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT
      );
      CREATE INDEX idx_logs_transaction ON installation_logs(transaction_id);

      CREATE TABLE verification_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL,
        version TEXT,
        transaction_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_verification_package ON verification_runs(package_id, started_at DESC);

      CREATE TABLE verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
        spec_id TEXT NOT NULL,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        passed INTEGER NOT NULL,
        output TEXT,
        expected TEXT,
        error TEXT,
        optional INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_verification_checks_run ON verification_checks(run_id);

      CREATE TABLE environment_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        audience TEXT NOT NULL,
        icon TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        notes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE profile_packages (
        profile_id TEXT NOT NULL REFERENCES environment_profiles(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL,
        optional INTEGER NOT NULL DEFAULT 0,
        preferred_version TEXT,
        PRIMARY KEY(profile_id, package_id)
      );

      CREATE TABLE environment_variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'variable',
        managed_by TEXT NOT NULL DEFAULT 'devforge',
        original_value TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, name)
      );

      CREATE TABLE environment_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        change_type TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        added_entries_json TEXT NOT NULL DEFAULT '[]',
        removed_entries_json TEXT NOT NULL DEFAULT '[]',
        transaction_id TEXT,
        package_id TEXT,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
      CREATE INDEX idx_env_backups_created ON environment_backups(created_at DESC);
      CREATE INDEX idx_env_backups_package ON environment_backups(package_id);

      CREATE TABLE user_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE download_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        url TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER,
        checksum TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(package_id, version)
      );

      CREATE TABLE update_cache (
        package_id TEXT PRIMARY KEY,
        available_version TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        package_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
    `
  }
]

function now(): string {
  return new Date().toISOString()
}

function bool(value: boolean): number {
  return value ? 1 : 0
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

interface InstallationRow {
  id: number
  package_id: string
  version: string
  method: string
  source: string
  install_dir: string | null
  status: string
  verification_status: string
  detected_version: string | null
  available_version: string | null
  env_status: string
  is_active: number
  installed_at: string
  updated_at: string
}

export interface InstallationInput {
  packageId: string
  version: string
  method: InstallationMethod
  source: 'devforge' | 'external'
  installDir: string | null
  status?: 'installed' | 'failed' | 'removed' | 'unknown'
  verificationStatus?: 'verified' | 'failed' | 'pending' | 'unknown'
  detectedVersion?: string | null
  availableVersion?: string | null
  envStatus?: 'configured' | 'not-configured' | 'unknown'
  isActive?: boolean
  installedAt?: string
}

export interface TransactionInput {
  id: string
  packageId: string
  version: string | null
  method: InstallationMethod
  installationId: number | null
  status: string
}

export interface LogInput {
  transactionId: string
  level: LogEntry['level']
  stage: string
  message: string
  command?: string | null
  args?: string[] | null
  exitCode?: number | null
  stdout?: string | null
  stderr?: string | null
}

export class AppDatabase {
  readonly filePath: string
  private db: DatabaseSync

  constructor(filePath: string) {
    this.filePath = filePath
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true })
    }
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)

    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (row) => row.version
      )
    )

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      this.db.exec('BEGIN')
      try {
        this.db.exec(migration.sql)
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, now())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }

  syncCatalog(packages: PackageDefinition[], builtinProfiles: ProfileDefinition[]): void {
    const timestamp = now()
    const upsertPackage = this.db.prepare(`
      INSERT INTO packages (
        id, name, category, description, publisher, homepage, documentation_url, license, icon,
        installation_method, package_manager_id, scope, requires_admin, requires_restart, advanced,
        supports_version_switching, detection_command, detection_version_pattern,
        detection_display_name_pattern, detection_service_pattern, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        description = excluded.description,
        publisher = excluded.publisher,
        homepage = excluded.homepage,
        documentation_url = excluded.documentation_url,
        license = excluded.license,
        icon = excluded.icon,
        installation_method = excluded.installation_method,
        package_manager_id = excluded.package_manager_id,
        scope = excluded.scope,
        requires_admin = excluded.requires_admin,
        requires_restart = excluded.requires_restart,
        advanced = excluded.advanced,
        supports_version_switching = excluded.supports_version_switching,
        detection_command = excluded.detection_command,
        detection_version_pattern = excluded.detection_version_pattern,
        detection_display_name_pattern = excluded.detection_display_name_pattern,
        detection_service_pattern = excluded.detection_service_pattern,
        updated_at = excluded.updated_at
    `)
    const upsertVersion = this.db.prepare(`
      INSERT INTO package_versions (
        package_id, version, channel, is_default, package_manager_id, download_url, archive_type,
        checksum, checksum_algorithm, size_bytes, install_args_json, estimated_size_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id, version) DO UPDATE SET
        channel = excluded.channel,
        is_default = excluded.is_default,
        package_manager_id = excluded.package_manager_id,
        download_url = excluded.download_url,
        archive_type = excluded.archive_type,
        checksum = excluded.checksum,
        checksum_algorithm = excluded.checksum_algorithm,
        size_bytes = excluded.size_bytes,
        install_args_json = excluded.install_args_json,
        estimated_size_bytes = excluded.estimated_size_bytes
    `)
    const insertDependency = this.db.prepare(
      'INSERT OR REPLACE INTO package_dependencies (package_id, dependency_id, kind, min_version, reason) VALUES (?, ?, ?, ?, ?)'
    )
    const insertEnv = this.db.prepare(
      'INSERT INTO package_environment_specs (package_id, kind, name, value_template, scope) VALUES (?, ?, ?, ?, ?)'
    )
    const insertVerification = this.db.prepare(`
      INSERT INTO package_verification_specs (
        package_id, spec_id, label, kind, command, args_json, expect_pattern, version_pattern,
        service_name_pattern, file_path_template, optional
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertDetectionPath = this.db.prepare(
      'INSERT INTO package_detection_paths (package_id, path_template) VALUES (?, ?)'
    )

    this.db.exec('BEGIN')
    try {
      for (const pkg of packages) {
        upsertPackage.run(
          pkg.id,
          pkg.name,
          pkg.category,
          pkg.description,
          pkg.publisher,
          pkg.homepage,
          pkg.documentationUrl ?? null,
          pkg.license,
          pkg.icon,
          pkg.installationMethod,
          pkg.packageManagerId ?? null,
          pkg.scope,
          bool(pkg.requiresAdmin),
          bool(pkg.requiresRestart),
          bool(pkg.advanced),
          bool(pkg.supportsVersionSwitching),
          pkg.detection.command ?? null,
          pkg.detection.versionPattern ?? null,
          pkg.detection.displayNamePattern ?? null,
          pkg.detection.serviceNamePattern ?? null,
          timestamp
        )

        this.db.prepare('DELETE FROM package_versions WHERE package_id = ?').run(pkg.id)
        for (const version of pkg.versions) {
          upsertVersion.run(
            pkg.id,
            version.version,
            version.channel,
            bool(version.isDefault),
            version.packageManagerId ?? null,
            version.download?.url ?? null,
            version.download?.archiveType ?? null,
            version.download?.checksum ?? null,
            version.download?.checksumAlgorithm ?? null,
            version.download?.sizeBytes ?? null,
            version.installArgs?.length ? JSON.stringify(version.installArgs) : null,
            version.estimatedSizeBytes ?? null
          )
        }

        this.db.prepare('DELETE FROM package_dependencies WHERE package_id = ?').run(pkg.id)
        for (const dependency of pkg.dependencies) {
          insertDependency.run(
            pkg.id,
            dependency.packageId,
            dependency.kind,
            dependency.minVersion ?? null,
            dependency.reason ?? null
          )
        }

        this.db.prepare('DELETE FROM package_environment_specs WHERE package_id = ?').run(pkg.id)
        for (const spec of pkg.environment) {
          insertEnv.run(pkg.id, spec.kind, spec.name, spec.valueTemplate, spec.scope)
        }

        this.db.prepare('DELETE FROM package_verification_specs WHERE package_id = ?').run(pkg.id)
        for (const spec of pkg.verification) {
          insertVerification.run(
            pkg.id,
            spec.id,
            spec.label,
            spec.kind,
            spec.command ?? null,
            JSON.stringify(spec.args ?? []),
            spec.expectPattern ?? null,
            spec.versionPattern ?? null,
            spec.serviceNamePattern ?? null,
            spec.filePathTemplate ?? null,
            bool(spec.optional)
          )
        }

        this.db.prepare('DELETE FROM package_detection_paths WHERE package_id = ?').run(pkg.id)
        for (const pathTemplate of pkg.detection.knownPaths) {
          insertDetectionPath.run(pkg.id, pathTemplate)
        }
      }

      const packageIds = packages.map((pkg) => pkg.id)
      if (packageIds.length > 0) {
        const placeholders = packageIds.map(() => '?').join(',')
        this.db
          .prepare(`DELETE FROM packages WHERE id NOT IN (${placeholders})`)
          .run(...packageIds)
      } else {
        this.db.prepare('DELETE FROM packages').run()
      }

      const builtinIds = builtinProfiles.map((profile) => profile.id)
      const upsertProfile = this.db.prepare(`
        INSERT INTO environment_profiles (id, name, description, audience, icon, is_builtin, notes_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          audience = excluded.audience,
          icon = excluded.icon,
          is_builtin = 1,
          notes_json = excluded.notes_json,
          updated_at = excluded.updated_at
      `)
      for (const profile of builtinProfiles) {
        const existing = this.db
          .prepare('SELECT created_at FROM environment_profiles WHERE id = ?')
          .get(profile.id) as { created_at: string } | undefined
        upsertProfile.run(
          profile.id,
          profile.name,
          profile.description,
          profile.audience,
          profile.icon,
          JSON.stringify(profile.notes),
          existing?.created_at ?? timestamp,
          timestamp
        )
        this.db.prepare('DELETE FROM profile_packages WHERE profile_id = ?').run(profile.id)
        for (const component of profile.components) {
          this.db
            .prepare(
              'INSERT INTO profile_packages (profile_id, package_id, optional, preferred_version) VALUES (?, ?, ?, ?)'
            )
            .run(profile.id, component.packageId, bool(component.optional), component.preferredVersion ?? null)
        }
      }
      if (builtinIds.length > 0) {
        const placeholders = builtinIds.map(() => '?').join(',')
        this.db
          .prepare(`DELETE FROM environment_profiles WHERE is_builtin = 1 AND id NOT IN (${placeholders})`)
          .run(...builtinIds)
      } else {
        this.db.prepare('DELETE FROM environment_profiles WHERE is_builtin = 1').run()
      }

      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Installations -----------------------------------------------------------

  upsertInstallation(input: InstallationInput): number {
    const timestamp = now()
    const existing = this.db
      .prepare(
        'SELECT id FROM installations WHERE package_id = ? AND version = ? AND source = ? ORDER BY id DESC LIMIT 1'
      )
      .get(input.packageId, input.version, input.source) as { id: number } | undefined

    if (existing) {
      this.db
        .prepare(
          `UPDATE installations SET
            method = ?, install_dir = ?, status = ?, verification_status = ?, detected_version = ?,
            available_version = ?, env_status = ?, is_active = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(
          input.method,
          input.installDir,
          input.status ?? 'installed',
          input.verificationStatus ?? 'unknown',
          input.detectedVersion ?? null,
          input.availableVersion ?? null,
          input.envStatus ?? 'unknown',
          bool(input.isActive ?? true),
          timestamp,
          existing.id
        )
      return existing.id
    }

    const result = this.db
      .prepare(
        `INSERT INTO installations (
          package_id, version, method, source, install_dir, status, verification_status,
          detected_version, available_version, env_status, is_active, installed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.packageId,
        input.version,
        input.method,
        input.source,
        input.installDir,
        input.status ?? 'installed',
        input.verificationStatus ?? 'unknown',
        input.detectedVersion ?? null,
        input.availableVersion ?? null,
        input.envStatus ?? 'unknown',
        bool(input.isActive ?? true),
        input.installedAt ?? timestamp,
        timestamp
      )
    return Number(result.lastInsertRowid)
  }

  listInstallations(): InstalledSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM installations ORDER BY installed_at DESC, id DESC')
      .all() as unknown as InstallationRow[]
    return rows.map(mapInstallation)
  }

  listInstallationsForPackage(packageId: string): InstalledSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM installations WHERE package_id = ? ORDER BY installed_at DESC, id DESC')
      .all(packageId) as unknown as InstallationRow[]
    return rows.map(mapInstallation)
  }

  getInstallation(id: number): InstalledSummary | null {
    const row = this.db.prepare('SELECT * FROM installations WHERE id = ?').get(id) as
      | InstallationRow
      | undefined
    return row ? mapInstallation(row) : null
  }

  setInstallationStatus(id: number, status: string): void {
    this.db
      .prepare('UPDATE installations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), id)
  }

  markPackageRemoved(packageId: string): void {
    this.db
      .prepare(
        "UPDATE installations SET status = 'removed', is_active = 0, updated_at = ? WHERE package_id = ? AND status != 'removed'"
      )
      .run(now(), packageId)
  }

  markExternalInstallationsRemoved(packageId: string): void {
    this.db
      .prepare(
        "UPDATE installations SET status = 'removed', is_active = 0, updated_at = ? WHERE package_id = ? AND source = 'external' AND status != 'removed'"
      )
      .run(now(), packageId)
  }

  markOtherInstallationsRemoved(packageId: string, keepId: number): void {
    this.db
      .prepare(
        "UPDATE installations SET status = 'removed', is_active = 0, updated_at = ? WHERE package_id = ? AND id != ? AND status != 'removed'"
      )
      .run(now(), packageId, keepId)
  }

  updateInstallationAfterInstall(
    id: number,
    patch: {
      installDir: string | null
      detectedVersion: string | null
      envStatus?: 'configured' | 'not-configured' | 'unknown'
      verificationStatus?: 'verified' | 'failed' | 'pending' | 'unknown'
      status?: string
      isActive?: boolean
    }
  ): void {
    this.db
      .prepare(
        `UPDATE installations SET install_dir = ?, detected_version = ?, env_status = COALESCE(?, env_status),
          verification_status = COALESCE(?, verification_status), status = COALESCE(?, status),
          is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?`
      )
      .run(
        patch.installDir,
        patch.detectedVersion,
        patch.envStatus ?? null,
        patch.verificationStatus ?? null,
        patch.status ?? null,
        patch.isActive === undefined ? null : bool(patch.isActive),
        now(),
        id
      )
  }

  setInstallationVerification(packageId: string, status: 'verified' | 'failed' | 'unknown'): void {
    this.db
      .prepare(
        "UPDATE installations SET verification_status = ?, updated_at = ? WHERE package_id = ? AND status != 'removed'"
      )
      .run(status, now(), packageId)
  }

  setActiveInstallation(packageId: string, version: string): void {
    this.db
      .prepare('UPDATE installations SET is_active = 0, updated_at = ? WHERE package_id = ?')
      .run(now(), packageId)
    this.db
      .prepare(
        "UPDATE installations SET is_active = 1, updated_at = ? WHERE package_id = ? AND version = ? AND status != 'removed'"
      )
      .run(now(), packageId, version)
  }

  setAvailableVersion(packageId: string, availableVersion: string | null): void {
    this.db
      .prepare("UPDATE installations SET available_version = ?, updated_at = ? WHERE package_id = ? AND status = 'installed'")
      .run(availableVersion, now(), packageId)
  }

  // Transactions ------------------------------------------------------------

  createTransaction(input: TransactionInput): void {
    this.db
      .prepare(
        `INSERT INTO installation_transactions (
          id, package_id, version, method, installation_id, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.packageId,
        input.version,
        input.method,
        input.installationId,
        input.status,
        now()
      )
  }

  updateTransactionStatus(id: string, status: string): void {
    this.db.prepare('UPDATE installation_transactions SET status = ? WHERE id = ?').run(status, id)
  }

  finishTransaction(
    id: string,
    status: string,
    options: { errorCode?: string | null; errorMessage?: string | null; verificationRunId?: number | null } = {}
  ): void {
    this.db
      .prepare(
        `UPDATE installation_transactions SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
         verification_run_id = COALESCE(?, verification_run_id) WHERE id = ?`
      )
      .run(
        status,
        now(),
        options.errorCode ?? null,
        options.errorMessage ?? null,
        options.verificationRunId ?? null,
        id
      )
  }

  markInterruptedTransactions(): number {
    const result = this.db
      .prepare(
        "UPDATE installation_transactions SET status = 'interrupted', finished_at = ?, error_message = 'DevForge closed before this operation finished.' WHERE status IN ('running', 'queued')"
      )
      .run(now())
    return Number(result.changes)
  }

  addLog(input: LogInput): void {
    this.db
      .prepare(
        `INSERT INTO installation_logs (
          transaction_id, timestamp, level, stage, message, command, args_json, exit_code, stdout, stderr
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.transactionId,
        now(),
        input.level,
        input.stage,
        input.message,
        input.command ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.exitCode ?? null,
        input.stdout ?? null,
        input.stderr ?? null
      )
  }

  listTransactions(limit = 100): TransactionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, p.name AS package_name,
          (SELECT COUNT(*) FROM installation_logs l WHERE l.transaction_id = t.id) AS log_count
         FROM installation_transactions t
         LEFT JOIN packages p ON p.id = t.package_id
         ORDER BY t.started_at DESC LIMIT ?`
      )
      .all(limit) as unknown as (Record<string, unknown> & { log_count: number })[]
    return rows.map((row) => ({
      id: String(row.id),
      packageId: String(row.package_id),
      packageName: String(row.package_name ?? row.package_id),
      version: (row.version as string | null) ?? null,
      method: row.method as InstallationMethod,
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: (row.finished_at as string | null) ?? null,
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      logCount: Number(row.log_count)
    }))
  }

  getTransaction(id: string): TransactionDetail | null {
    const record = this.listTransactions(1000).find((transaction) => transaction.id === id)
    if (!record) return null
    const logs = (
      this.db
        .prepare('SELECT * FROM installation_logs WHERE transaction_id = ? ORDER BY id ASC')
        .all(id) as unknown as Record<string, unknown>[]
    ).map((row) => ({
      id: Number(row.id),
      transactionId: String(row.transaction_id),
      timestamp: String(row.timestamp),
      level: row.level as LogEntry['level'],
      stage: String(row.stage),
      message: String(row.message),
      command: (row.command as string | null) ?? null,
      args: row.args_json ? (JSON.parse(String(row.args_json)) as string[]) : null,
      exitCode: (row.exit_code as number | null) ?? null,
      stdout: (row.stdout as string | null) ?? null,
      stderr: (row.stderr as string | null) ?? null
    }))
    const verificationRow = this.db
      .prepare('SELECT verification_run_id FROM installation_transactions WHERE id = ?')
      .get(id) as { verification_run_id: number | null } | undefined
    const verification = verificationRow?.verification_run_id
      ? this.getVerificationRun(Number(verificationRow.verification_run_id))
      : null
    const envChanges = this.db
      .prepare('SELECT * FROM environment_backups WHERE transaction_id = ? ORDER BY created_at ASC')
      .all(id) as unknown as Record<string, unknown>[]
    return {
      ...record,
      logs,
      envChanges: envChanges.map((row) => mapEnvBackup(row)),
      verification
    }
  }

  // Verification ------------------------------------------------------------

  createVerificationRun(packageId: string, version: string | null, transactionId: string | null): number {
    const result = this.db
      .prepare(
        "INSERT INTO verification_runs (package_id, version, transaction_id, status, started_at) VALUES (?, ?, ?, 'running', ?)"
      )
      .run(packageId, version, transactionId, now())
    return Number(result.lastInsertRowid)
  }

  addVerificationCheck(runId: number, check: VerificationCheck): void {
    this.db
      .prepare(
        `INSERT INTO verification_checks (run_id, spec_id, label, command, passed, output, expected, error, optional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        check.id,
        check.label,
        check.command,
        bool(check.passed),
        check.output,
        check.expected,
        check.error,
        bool(check.optional)
      )
  }

  finishVerificationRun(runId: number, status: 'passed' | 'failed'): void {
    this.db
      .prepare('UPDATE verification_runs SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, now(), runId)
  }

  getVerificationRun(runId: number): VerificationRun | null {
    const row = this.db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(runId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const checks = this.db
      .prepare('SELECT * FROM verification_checks WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as unknown as Record<string, unknown>[]
    return {
      id: Number(row.id),
      packageId: String(row.package_id),
      version: (row.version as string | null) ?? null,
      status: row.status as 'passed' | 'failed',
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at ?? row.started_at),
      checks: checks.map((check) => ({
        id: String(check.spec_id),
        label: String(check.label),
        command: String(check.command),
        passed: Boolean(check.passed),
        output: String(check.output ?? ''),
        expected: (check.expected as string | null) ?? null,
        error: (check.error as string | null) ?? null,
        optional: Boolean(check.optional)
      }))
    }
  }

  getLatestVerificationRun(packageId: string): VerificationRun | null {
    const row = this.db
      .prepare('SELECT id FROM verification_runs WHERE package_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(packageId) as { id: number } | undefined
    return row ? this.getVerificationRun(row.id) : null
  }

  // Activity ----------------------------------------------------------------

  addActivity(entry: Omit<ActivityEntry, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        'INSERT INTO activity_log (type, level, title, message, package_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(entry.type, entry.level, entry.title, entry.message, entry.packageId, now())
  }

  listActivity(limit = 20): ActivityEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type as ActivityEntry['type'],
      level: row.level as ActivityEntry['level'],
      title: String(row.title),
      message: (row.message as string | null) ?? null,
      packageId: (row.package_id as string | null) ?? null,
      createdAt: String(row.created_at)
    }))
  }

  // Environment -------------------------------------------------------------

  listManagedVariables(): { scope: EnvScope; name: string; value: string; kind: string; originalValue: string | null; updatedAt: string }[] {
    const rows = this.db.prepare('SELECT * FROM environment_variables ORDER BY scope, name').all() as unknown as Record<
      string,
      unknown
    >[]
    return rows.map((row) => ({
      scope: row.scope as EnvScope,
      name: String(row.name),
      value: String(row.value),
      kind: String(row.kind),
      originalValue: (row.original_value as string | null) ?? null,
      updatedAt: String(row.updated_at)
    }))
  }

  upsertManagedVariable(input: {
    scope: EnvScope
    name: string
    value: string
    kind: 'variable' | 'path'
    originalValue: string | null
  }): void {
    const existing = this.db
      .prepare('SELECT original_value FROM environment_variables WHERE scope = ? AND name = ?')
      .get(input.scope, input.name) as { original_value: string | null } | undefined
    this.db
      .prepare(
        `INSERT INTO environment_variables (scope, name, value, kind, managed_by, original_value, updated_at)
         VALUES (?, ?, ?, ?, 'devforge', ?, ?)
         ON CONFLICT(scope, name) DO UPDATE SET
           value = excluded.value, kind = excluded.kind, original_value = COALESCE(environment_variables.original_value, excluded.original_value),
           updated_at = excluded.updated_at`
      )
      .run(
        input.scope,
        input.name,
        input.value,
        input.kind,
        existing ? existing.original_value : input.originalValue,
        now()
      )
  }

  deleteManagedVariable(scope: EnvScope, name: string): void {
    this.db.prepare('DELETE FROM environment_variables WHERE scope = ? AND name = ?').run(scope, name)
  }

  addEnvironmentBackup(input: Omit<EnvBackup, 'id' | 'createdAt' | 'restoredAt' | 'packageName'> & {
    addedEntries: string[]
    removedEntries: string[]
    packageId?: string | null
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO environment_backups (
          scope, name, kind, change_type, previous_value, new_value, added_entries_json,
          removed_entries_json, transaction_id, package_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.scope,
        input.name,
        input.kind,
        input.changeType,
        input.previousValue,
        input.newValue,
        JSON.stringify(input.addedEntries),
        JSON.stringify(input.removedEntries),
        input.transactionId ?? null,
        input.packageId ?? null,
        now()
      )
    return Number(result.lastInsertRowid)
  }

  listEnvironmentBackups(limit = 100): EnvBackup[] {
    const rows = this.db
      .prepare(
        `SELECT b.*, p.name AS package_name FROM environment_backups b
         LEFT JOIN packages p ON p.id = b.package_id
         ORDER BY b.created_at DESC, b.id DESC LIMIT ?`
      )
      .all(limit) as unknown as Record<string, unknown>[]
    return rows.map((row) => mapEnvBackup(row, (row.package_name as string | null) ?? null))
  }

  getEnvironmentBackup(id: number): (EnvBackup & { addedEntries: string[]; removedEntries: string[]; packageId: string | null }) | null {
    const row = this.db.prepare('SELECT * FROM environment_backups WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return {
      ...mapEnvBackup(row),
      addedEntries: parseJsonArray(row.added_entries_json as string),
      removedEntries: parseJsonArray(row.removed_entries_json as string),
      packageId: (row.package_id as string | null) ?? null
    }
  }

  listEnvironmentBackupsForPackage(packageId: string): (EnvBackup & { addedEntries: string[]; removedEntries: string[] })[] {
    const rows = this.db
      .prepare('SELECT * FROM environment_backups WHERE package_id = ? ORDER BY created_at DESC, id DESC')
      .all(packageId) as unknown as Record<string, unknown>[]
    return rows.map((row) => ({
      ...mapEnvBackup(row),
      addedEntries: parseJsonArray(row.added_entries_json as string),
      removedEntries: parseJsonArray(row.removed_entries_json as string)
    }))
  }

  markEnvironmentBackupRestored(id: number): void {
    this.db.prepare('UPDATE environment_backups SET restored_at = ? WHERE id = ?').run(now(), id)
  }

  listActiveManagedPathEntries(): { scope: EnvScope; entry: string }[] {
    const rows = this.db
      .prepare(
        "SELECT scope, added_entries_json FROM environment_backups WHERE restored_at IS NULL AND change_type = 'add-path'"
      )
      .all() as unknown as { scope: EnvScope; added_entries_json: string }[]
    return rows.flatMap((row) =>
      parseJsonArray(row.added_entries_json).map((entry) => ({ scope: row.scope, entry }))
    )
  }

  // Settings ----------------------------------------------------------------

  getSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM user_settings').all() as unknown as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  }

  saveSettings(settings: AppSettings): void {
    const statement = this.db.prepare(
      `INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    const timestamp = now()
    this.db.exec('BEGIN')
    try {
      for (const [key, value] of Object.entries(settings)) {
        statement.run(key, JSON.stringify(value), timestamp)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearSettings(): void {
    this.db.prepare('DELETE FROM user_settings').run()
  }

  // Profiles ----------------------------------------------------------------

  listProfiles(): EnvironmentProfile[] {
    const profiles = this.db
      .prepare('SELECT * FROM environment_profiles ORDER BY is_builtin DESC, name COLLATE NOCASE')
      .all() as unknown as Record<string, unknown>[]
    return profiles.map((profile) => {
      const components = this.db
        .prepare('SELECT * FROM profile_packages WHERE profile_id = ?')
        .all(String(profile.id)) as unknown as Record<string, unknown>[]
      return {
        id: String(profile.id),
        name: String(profile.name),
        description: String(profile.description),
        audience: String(profile.audience),
        icon: String(profile.icon),
        isBuiltin: Boolean(profile.is_builtin),
        notes: parseJsonArray(profile.notes_json as string),
        components: components.map((component) => ({
          packageId: String(component.package_id),
          optional: Boolean(component.optional),
          preferredVersion: (component.preferred_version as string | null) ?? null
        })),
        createdAt: (profile.created_at as string | null) ?? null,
        updatedAt: (profile.updated_at as string | null) ?? null
      }
    })
  }

  createProfile(input: ProfileInput): EnvironmentProfile {
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const timestamp = now()
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          'INSERT INTO environment_profiles (id, name, description, audience, icon, is_builtin, notes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
        )
        .run(id, input.name, input.description, input.audience, input.icon, '[]', timestamp, timestamp)
      this.insertProfileComponents(id, input.components)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const created = this.listProfiles().find((profile) => profile.id === id)
    if (!created) throw new Error('Failed to create profile')
    return created
  }

  updateProfile(id: string, input: ProfileInput): EnvironmentProfile {
    const existing = this.db.prepare('SELECT is_builtin FROM environment_profiles WHERE id = ?').get(id) as
      | { is_builtin: number }
      | undefined
    if (!existing) throw new Error('Profile not found')
    if (existing.is_builtin) throw new Error('Built-in profiles cannot be edited. Duplicate it to create a custom version.')
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          'UPDATE environment_profiles SET name = ?, description = ?, audience = ?, icon = ?, updated_at = ? WHERE id = ?'
        )
        .run(input.name, input.description, input.audience, input.icon, now(), id)
      this.db.prepare('DELETE FROM profile_packages WHERE profile_id = ?').run(id)
      this.insertProfileComponents(id, input.components)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const updated = this.listProfiles().find((profile) => profile.id === id)
    if (!updated) throw new Error('Failed to update profile')
    return updated
  }

  deleteProfile(id: string): void {
    const existing = this.db.prepare('SELECT is_builtin FROM environment_profiles WHERE id = ?').get(id) as
      | { is_builtin: number }
      | undefined
    if (!existing) throw new Error('Profile not found')
    if (existing.is_builtin) throw new Error('Built-in profiles cannot be deleted.')
    this.db.prepare('DELETE FROM environment_profiles WHERE id = ?').run(id)
  }

  private insertProfileComponents(profileId: string, components: ProfileInput['components']): void {
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO profile_packages (profile_id, package_id, optional, preferred_version) VALUES (?, ?, ?, ?)'
    )
    for (const component of components) {
      statement.run(profileId, component.packageId, bool(Boolean(component.optional)), component.preferredVersion ?? null)
    }
  }

  // Updates cache -----------------------------------------------------------

  saveUpdateCache(packageId: string, availableVersion: string): void {
    this.db
      .prepare(
        `INSERT INTO update_cache (package_id, available_version, checked_at) VALUES (?, ?, ?)
         ON CONFLICT(package_id) DO UPDATE SET available_version = excluded.available_version, checked_at = excluded.checked_at`
      )
      .run(packageId, availableVersion, now())
  }

  getUpdateCache(): Map<string, { availableVersion: string; checkedAt: string }> {
    const rows = this.db.prepare('SELECT * FROM update_cache').all() as unknown as Record<string, unknown>[]
    return new Map(
      rows.map((row) => [
        String(row.package_id),
        { availableVersion: String(row.available_version), checkedAt: String(row.checked_at) }
      ])
    )
  }

  // Downloads ---------------------------------------------------------------

  saveDownload(input: {
    packageId: string
    version: string
    url: string
    filePath: string
    sizeBytes: number
    checksum: string
    status: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO download_cache (package_id, version, url, file_path, size_bytes, checksum, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(package_id, version) DO UPDATE SET
           file_path = excluded.file_path, size_bytes = excluded.size_bytes, checksum = excluded.checksum,
           status = excluded.status, created_at = excluded.created_at`
      )
      .run(
        input.packageId,
        input.version,
        input.url,
        input.filePath,
        input.sizeBytes,
        input.checksum,
        input.status,
        now()
      )
  }

  listDownloads(): { id: number; packageId: string; version: string; filePath: string; sizeBytes: number | null }[] {
    const rows = this.db.prepare('SELECT * FROM download_cache').all() as unknown as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      packageId: String(row.package_id),
      version: String(row.version),
      filePath: String(row.file_path),
      sizeBytes: (row.size_bytes as number | null) ?? null
    }))
  }

  clearDownloads(): void {
    this.db.prepare('DELETE FROM download_cache').run()
  }

  // Diagnostics -------------------------------------------------------------

  counts(): Record<string, number> {
    const tables = [
      'packages',
      'package_versions',
      'installations',
      'installation_transactions',
      'installation_logs',
      'environment_profiles',
      'environment_backups',
      'activity_log'
    ]
    const result: Record<string, number> = {}
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      result[table] = Number(row.count)
    }
    return result
  }
}

function mapInstallation(row: InstallationRow): InstalledSummary {
  return {
    id: Number(row.id),
    packageId: row.package_id,
    version: row.version,
    method: row.method as InstallationMethod,
    source: row.source as 'devforge' | 'external',
    installDir: row.install_dir,
    status: row.status as InstalledSummary['status'],
    verificationStatus: row.verification_status as InstalledSummary['verificationStatus'],
    detectedVersion: row.detected_version,
    availableVersion: row.available_version,
    envStatus: row.env_status as InstalledSummary['envStatus'],
    isActive: Boolean(row.is_active),
    installedAt: row.installed_at,
    updatedAt: row.updated_at
  }
}

function mapEnvBackup(row: Record<string, unknown>, packageName: string | null = null): EnvBackup {
  return {
    id: Number(row.id),
    scope: row.scope as EnvScope,
    name: String(row.name),
    kind: (row.kind as 'variable' | 'path') ?? 'variable',
    changeType: String(row.change_type),
    previousValue: (row.previous_value as string | null) ?? null,
    newValue: (row.new_value as string | null) ?? null,
    createdAt: String(row.created_at),
    restoredAt: (row.restored_at as string | null) ?? null,
    transactionId: (row.transaction_id as string | null) ?? null,
    packageName
  }
}

export type { ProfileComponent }
