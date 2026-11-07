import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Cpu,
  Database,
  Download,
  FolderCog,
  FolderOpen,
  Globe,
  HardDriveDownload,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Wrench
} from 'lucide-react'
import type { AppSettings, ThemePreference } from '@shared/types'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useDatabaseInfo, useSettings, useSystemInfo } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState } from '@/components/common/ErrorState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

const startupPages = [
  { value: '/dashboard', label: 'Dashboard' },
  { value: '/discover', label: 'Discover Software' },
  { value: '/environments', label: 'Development Environments' },
  { value: '/installed', label: 'Installed Software' },
  { value: '/queue', label: 'Installation Queue' },
  { value: '/environment-variables', label: 'Environment Variables' },
  { value: '/versions', label: 'Version Manager' },
  { value: '/history', label: 'Installation History' },
  { value: '/settings', label: 'Settings' }
]

const themes: { value: ThemePreference; label: string; icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor }
]

interface SectionProps {
  icon: typeof Palette
  title: string
  description: string
  children: ReactNode
}

function Section({ icon: Icon, title, description, children }: SectionProps): ReactNode {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-secondary/60 text-primary">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          <CardDescription className="mt-1">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">{children}</CardContent>
    </Card>
  )
}

interface RowProps {
  title: string
  description?: string
  control: ReactNode
  stacked?: boolean
}

function Row({ title, description, control, stacked }: RowProps): ReactNode {
  if (stacked) {
    return (
      <div className="space-y-2.5 py-4 first:pt-0 last:pb-0">
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {control}
      </div>
    )
  }
  return (
    <div className="flex items-start justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-foreground">{value}</span>
    </div>
  )
}

export default function SettingsPage(): ReactNode {
  const queryClient = useQueryClient()
  const settingsQuery = useSettings()
  const infoQuery = useSystemInfo()
  const databaseQuery = useDatabaseInfo()
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (settingsQuery.data && draft === null) setDraft(settingsQuery.data)
  }, [settingsQuery.data, draft])

  const dirty = useMemo(() => {
    if (!draft || !settingsQuery.data) return false
    return JSON.stringify(draft) !== JSON.stringify(settingsQuery.data)
  }, [draft, settingsQuery.data])

  const saveMutation = useMutation({
    mutationFn: (next: AppSettings) => api.settings.update(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.settings, updated)
      setDraft(updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.info })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      notifySuccess('Settings saved', 'Your preferences have been applied.')
    },
    onError: (error) => notifyError(error)
  })

  const resetMutation = useMutation({
    mutationFn: () => api.settings.reset(),
    onSuccess: (fresh) => {
      queryClient.setQueryData(queryKeys.settings, fresh)
      setDraft(fresh)
      setConfirmReset(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.info })
      notifySuccess('Settings reset', 'All preferences were restored to their defaults.')
    },
    onError: (error) => {
      setConfirmReset(false)
      notifyError(error)
    }
  })

  const clearMutation = useMutation({
    mutationFn: () => api.settings.clearDownloads(),
    onSuccess: (result) => {
      setConfirmClear(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.databaseInfo })
      notifySuccess(
        'Download cache cleared',
        result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)} of temporary files.` : 'There was nothing to clean up.'
      )
    },
    onError: (error) => {
      setConfirmClear(false)
      notifyError(error)
    }
  })

  const diagnosticsMutation = useMutation({
    mutationFn: () => api.settings.diagnostics(),
    onSuccess: (result) => {
      notifySuccess('Diagnostics exported', 'A system report and logs were written to disk.')
      void api.system.showInFolder(result.path)
    },
    onError: (error) => notifyError(error)
  })

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    )
  }

  if (settingsQuery.isError || !draft) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="System" title="Settings" description="Application preferences and maintenance tools." />
        <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      </div>
    )
  }

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous))
  }

  const info = infoQuery.data
  const database = databaseQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="System"
        title="Settings"
        description="Control how DevForge installs software, changes your environment and notifies you. Settings are stored locally on this machine."
        actions={
          <>
            {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
            <Button variant="ghost" onClick={() => setConfirmReset(true)} disabled={resetMutation.isPending}>
              <RotateCcw />
              Reset defaults
            </Button>
            <Button onClick={() => saveMutation.mutate(draft)} disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}
              Save changes
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section
            icon={Palette}
            title="Appearance"
            description="Choose how DevForge looks and where it opens."
          >
            <Row
              title="Theme"
              description="System follows the Windows light or dark mode setting."
              control={
                <div className="flex overflow-hidden rounded-lg border border-border/70">
                  {themes.map((theme) => {
                    const Icon = theme.icon
                    const active = draft.theme === theme.value
                    return (
                      <button
                        key={theme.value}
                        type="button"
                        onClick={() => update('theme', theme.value)}
                        className={
                          active
                            ? 'flex items-center gap-1.5 bg-secondary px-3 py-1.5 text-xs font-medium text-foreground'
                            : 'flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground'
                        }
                      >
                        <Icon className="size-3.5" />
                        {theme.label}
                      </button>
                    )
                  })}
                </div>
              }
            />
            <Row
              title="Startup page"
              description="The page DevForge opens when you launch the app."
              control={
                <Select value={draft.startupPage} onValueChange={(value) => update('startupPage', value)}>
                  <SelectTrigger className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {startupPages.map((page) => (
                      <SelectItem key={page.value} value={page.value}>
                        {page.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </Section>

          <Section
            icon={FolderCog}
            title="Installation defaults"
            description="Defaults used when DevForge builds an installation plan. You can still override them per package."
          >
            <Row
              stacked
              title="Tools directory"
              description="New installations and managed archives are placed in subfolders of this directory. Existing folders are never overwritten blindly."
              control={
                <div className="flex gap-2">
                  <Input
                    value={draft.installDir}
                    onChange={(event) => update('installDir', event.target.value)}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  {info ? (
                    <Button
                      variant="outline"
                      size="icon"
                      title="Open current tools directory"
                      onClick={() => void api.system.openPath(info.toolsDir)}
                    >
                      <FolderOpen />
                    </Button>
                  ) : null}
                </div>
              }
            />
            <Row
              title="Default installation scope"
              description="User-scope installs do not require elevation. System scope applies to all users."
              control={
                <Select
                  value={draft.installScope}
                  onValueChange={(value) => update('installScope', value as AppSettings['installScope'])}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Current user</SelectItem>
                    <SelectItem value="system">All users</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <Row
              title="Preferred method"
              description="Auto lets DevForge pick the method a package declares. Overrides are only used when the package supports them."
              control={
                <Select
                  value={draft.defaultMethod}
                  onValueChange={(value) => update('defaultMethod', value as AppSettings['defaultMethod'])}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (recommended)</SelectItem>
                    <SelectItem value="winget">WinGet</SelectItem>
                    <SelectItem value="archive">Verified archive</SelectItem>
                    <SelectItem value="official-installer">Official installer</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <Row
              title="Verify after installation"
              description="Run the package's verification checks and record the result in installation history."
              control={
                <Switch
                  checked={draft.autoVerify}
                  onCheckedChange={(checked) => update('autoVerify', checked)}
                  aria-label="Verify after installation"
                />
              }
            />
            <Row
              title="Confirm before installing"
              description="Always show the installation plan before anything is downloaded or executed."
              control={
                <Switch
                  checked={draft.confirmInstall}
                  onCheckedChange={(checked) => update('confirmInstall', checked)}
                  aria-label="Confirm before installing"
                />
              }
            />
          </Section>

          <Section
            icon={HardDriveDownload}
            title="Downloads"
            description="Installer files are fetched over HTTPS from sources declared in the validated registry and checked against their published checksums."
          >
            <Row
              stacked
              title="Download directory"
              description="Temporary installers and archives are cached here. Clear the cache at any time from maintenance."
              control={
                <div className="flex gap-2">
                  <Input
                    value={draft.downloadDir}
                    onChange={(event) => update('downloadDir', event.target.value)}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  {info ? (
                    <Button
                      variant="outline"
                      size="icon"
                      title="Open download directory"
                      onClick={() => void api.system.openPath(info.downloadDir)}
                    >
                      <FolderOpen />
                    </Button>
                  ) : null}
                </div>
              }
            />
            <Row
              title="Concurrent downloads"
              description="Higher values use more bandwidth. Installations themselves always run one at a time."
              control={
                <Select
                  value={String(draft.concurrentDownloads)}
                  onValueChange={(value) => update('concurrentDownloads', Number(value))}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 at a time</SelectItem>
                    <SelectItem value="2">2 at a time</SelectItem>
                    <SelectItem value="3">3 at a time</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          </Section>

          <Section
            icon={SlidersHorizontal}
            title="Environment variables"
            description="Defaults for PATH and variable changes. DevForge always preserves unrelated entries and records a backup before editing."
          >
            <Row
              title="Default scope"
              description="Which scope new PATH entries and variables are written to."
              control={
                <Select
                  value={draft.envScope}
                  onValueChange={(value) => update('envScope', value as AppSettings['envScope'])}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Current user</SelectItem>
                    <SelectItem value="system">All users</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <Row
              title="PATH insertion strategy"
              description="Prepend puts managed tools first. Append keeps existing entries ahead of them."
              control={
                <Select
                  value={draft.pathStrategy}
                  onValueChange={(value) => update('pathStrategy', value as AppSettings['pathStrategy'])}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">Append</SelectItem>
                    <SelectItem value="prepend">Prepend</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <Row
              title="Back up before changes"
              description="Capture the current value so a specific change can be reverted later. Restores are targeted, not whole-snapshot overwrites."
              control={
                <Switch
                  checked={draft.backupBeforeChange}
                  onCheckedChange={(checked) => update('backupBeforeChange', checked)}
                  aria-label="Back up before environment changes"
                />
              }
            />
          </Section>

          <Section
            icon={Bell}
            title="Notifications"
            description="Desktop notifications raised when background work finishes."
          >
            <Row
              title="Installation completed"
              description="Notify when a package finishes installing successfully."
              control={
                <Switch
                  checked={draft.notifyOnComplete}
                  onCheckedChange={(checked) => update('notifyOnComplete', checked)}
                  aria-label="Notify when installations complete"
                />
              }
            />
            <Row
              title="Installation failed"
              description="Notify when an installation fails or is cancelled."
              control={
                <Switch
                  checked={draft.notifyOnFailure}
                  onCheckedChange={(checked) => update('notifyOnFailure', checked)}
                  aria-label="Notify when installations fail"
                />
              }
            />
            <Row
              title="Updates available"
              description="Notify when installed packages have a newer version in the registry."
              control={
                <Switch
                  checked={draft.notifyOnUpdates}
                  onCheckedChange={(checked) => update('notifyOnUpdates', checked)}
                  aria-label="Notify when updates are available"
                />
              }
            />
          </Section>

          <Section
            icon={RefreshCw}
            title="Updates"
            description="DevForge compares installed versions with the registry and, when enabled, the vendor's official release feed."
          >
            <Row
              title="Check vendor release feeds"
              description="Read canonical GitHub and vendor feeds for packages that declare an official source. Upstream-only updates are reported as informational because they may not be installable through the package definition."
              control={
                <Switch
                  checked={draft.checkUpstreamUpdates}
                  onCheckedChange={(checked) => update('checkUpstreamUpdates', checked)}
                  aria-label="Check vendor release feeds"
                />
              }
            />
          </Section>

          <Section
            icon={Globe}
            title="Network"
            description="Route DevForge downloads and release lookups through an HTTP proxy. WinGet and official installers also receive these proxy variables."
          >
            <Row
              stacked
              title="Proxy URL"
              description="Leave empty to use the Windows system proxy. Only http:// and https:// proxies are accepted."
              control={
                <Input
                  value={draft.proxyUrl}
                  onChange={(event) => update('proxyUrl', event.target.value)}
                  placeholder="http://proxy.example.com:8080"
                  spellCheck={false}
                  className="font-mono text-xs"
                  aria-label="Proxy URL"
                />
              }
            />
            <Row
              stacked
              title="Proxy bypass list"
              description="Hosts that should connect directly, separated by semicolons (for example localhost;*.internal)."
              control={
                <Input
                  value={draft.proxyBypass}
                  onChange={(event) => update('proxyBypass', event.target.value)}
                  placeholder="localhost;*.internal"
                  spellCheck={false}
                  className="font-mono text-xs"
                  aria-label="Proxy bypass list"
                />
              }
            />
          </Section>

          <Section
            icon={Monitor}
            title="Background and startup"
            description="Control what happens when you close the window and how an interrupted queue is handled."
          >
            <Row
              title="Keep running in the tray"
              description="Closing the window hides DevForge instead of quitting, so a running installation queue can finish. Use the tray menu to reopen, pause, resume or quit."
              control={
                <Switch
                  checked={draft.keepInTray}
                  onCheckedChange={(checked) => update('keepInTray', checked)}
                  aria-label="Keep running in the tray"
                />
              }
            />
            <Row
              title="Resume pending queue on startup"
              description="Restore items that were still waiting when DevForge last closed. If the queue was running, it starts again after the package registry has been loaded."
              control={
                <Switch
                  checked={draft.resumeQueueOnStartup}
                  onCheckedChange={(checked) => update('resumeQueueOnStartup', checked)}
                  aria-label="Resume pending queue on startup"
                />
              }
            />
          </Section>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="size-4 text-primary" />
                About this system
              </CardTitle>
              <CardDescription>Runtime information reported by the main process.</CardDescription>
            </CardHeader>
            <CardContent>
              {info ? (
                <>
                  <InfoLine label="DevForge" value={`v${info.appVersion}`} />
                  <InfoLine label="Windows" value={info.windowsVersion} />
                  <InfoLine label="Host" value={`${info.hostname} · ${info.username}`} />
                  <InfoLine label="Architecture" value={info.arch} />
                  <InfoLine label="Electron" value={info.electronVersion} />
                  <InfoLine label="Chromium" value={info.chromeVersion} />
                  <InfoLine label="Node.js" value={info.nodeVersion} />
                  <InfoLine label="PowerShell" value={info.powershellVersion ?? 'Not detected'} />
                  <InfoLine label="WinGet" value={info.wingetVersion ?? 'Not available'} />
                  <InfoLine
                    label="Privileges"
                    value={
                      info.isElevated ? (
                        <Badge variant="warning">Elevated</Badge>
                      ) : (
                        <Badge variant="success">Standard user</Badge>
                      )
                    }
                  />
                  <Separator className="my-3" />
                  <div className="space-y-2 text-xs">
                    <p className="text-muted-foreground">Tools directory</p>
                    <div className="flex items-center gap-1">
                      <code className="min-w-0 flex-1 break-all rounded bg-secondary/50 px-2 py-1 font-mono text-[11px]">
                        {info.toolsDir}
                      </code>
                      <CopyButton value={info.toolsDir} />
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button variant="outline" size="sm" onClick={() => void api.system.openPath(info.toolsDir)}>
                        <FolderOpen />
                        Open tools
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void api.system.openPath(info.logsDir)}>
                        <FolderOpen />
                        Logs
                      </Button>
                    </div>
                  </div>
                </>
              ) : infoQuery.isError ? (
                <p className="text-xs text-muted-foreground">System information is unavailable right now.</p>
              ) : (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="size-4 text-primary" />
                Local database
              </CardTitle>
              <CardDescription>DevForge stores installations, logs and settings in a local SQLite database.</CardDescription>
            </CardHeader>
            <CardContent>
              {database ? (
                <>
                  <InfoLine label="Size" value={formatBytes(database.sizeBytes)} />
                  <div className="mt-2 space-y-1.5">
                    {Object.entries(database.counts).map(([table, count]) => (
                      <div key={table} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{table.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                  <Separator className="my-3" />
                  <p className="break-all text-[11px] text-muted-foreground">{database.path}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void api.system.showInFolder(database.path)}
                  >
                    <FolderOpen />
                    Show database file
                  </Button>
                </>
              ) : (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wrench className="size-4 text-primary" />
                Maintenance
              </CardTitle>
              <CardDescription>Diagnostics, caches and safety-critical actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => diagnosticsMutation.mutate()}
                disabled={diagnosticsMutation.isPending}
              >
                {diagnosticsMutation.isPending ? <Loader2 className="animate-spin" /> : <Download />}
                Export diagnostics
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => setConfirmClear(true)}
                disabled={clearMutation.isPending}
              >
                <Trash2 />
                Clear download cache
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => setConfirmReset(true)}
                disabled={resetMutation.isPending}
              >
                <RotateCcw />
                Reset all settings
              </Button>
              <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 p-3 text-[11px] leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>
                  DevForge never stores database passwords in settings. Secrets for databases you create are managed
                  separately and are not written to plain-text logs.
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Local-only application</CardTitle>
              <CardDescription>All data stays on this machine.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-5 text-muted-foreground">
              <p>
                Downloads come from official HTTPS sources declared in the validated package registry and are checked
                against published checksums before anything is executed.
              </p>
              <p>
                Want to review what changed? Open the{' '}
                <Link to="/history" className="font-medium text-primary hover:underline">
                  installation history
                </Link>{' '}
                or the{' '}
                <Link to="/environment-variables" className="font-medium text-primary hover:underline">
                  environment backups
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset all settings?"
        description="Every preference on this page returns to its default value. Installed software, history and environment backups are not affected."
        confirmLabel="Reset settings"
        destructive
        loading={resetMutation.isPending}
        onConfirm={() => resetMutation.mutate()}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the download cache?"
        description="Cached installers and archives are deleted. A future install re-downloads what it needs and verifies it again."
        confirmLabel="Clear cache"
        loading={clearMutation.isPending}
        onConfirm={() => clearMutation.mutate()}
      />
    </div>
  )
}
