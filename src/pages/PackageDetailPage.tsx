import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowUpCircle,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  Globe,
  History,
  Info,
  Layers,
  Package,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TriangleAlert
} from 'lucide-react'
import type { InstallRequest } from '@shared/types'
import { sortVersionRecordsDescending } from '@shared/version'
import { api } from '@/lib/api'
import { categoryLabels, formatBytes, formatDuration, formatRelative, methodLabels } from '@/lib/format'
import { useCatalogue, useHistory, usePackage } from '@/hooks/useData'
import { StatusBadge } from '@/components/common/StatusBadge'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PlanDialog } from '@/components/common/PlanDialog'
import { RecipeDialog } from '@/components/common/RecipeDialog'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'

export default function PackageDetailPage(): ReactNode {
  const { packageId } = useParams<{ packageId: string }>()
  const packageQuery = usePackage(packageId)
  const catalogueQuery = useCatalogue()
  const historyQuery = useHistory(50)
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [tab, setTab] = useState('overview')
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])
  const [recipeOpen, setRecipeOpen] = useState(false)

  const item = packageQuery.data

  useEffect(() => {
    if (!item) return
    setSelectedVersion((current) => {
      if (current && item.package.versions.some((version) => version.version === current)) return current
      return item.defaultVersion ?? item.latestVersion ?? null
    })
    setTab('overview')
  }, [item])

  if (packageQuery.isLoading) {
    return (
      <div className="animate-fade-in space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  if (packageQuery.isError) {
    return (
      <div className="animate-fade-in space-y-4">
        <BackLink />
        <ErrorState error={packageQuery.error} onRetry={() => void packageQuery.refetch()} />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="animate-fade-in space-y-4">
        <BackLink />
        <EmptyState
          icon={<Package />}
          title="Package not found"
          description="This package is not present in the registry, or its definition failed validation."
          action={
            <Button asChild size="sm">
              <Link to="/discover">Back to Discover Software</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const pkg = item.package
  const identity = item.identity
  const versionSourceLabel = identity
    ? (versionSourceLabels[identity.versionSource] ?? identity.versionSource)
    : 'Package manifest only'
  const recipe = pkg.installationMethod === 'project-recipe'
  const versions = sortVersionRecordsDescending(pkg.versions)
  const installed = item.installed
  const installedVersions = new Set(
    item.installations.filter((record) => record.status === 'installed').map((record) => record.version)
  )
  const selected = versions.find((version) => version.version === selectedVersion) ?? versions[0]
  const selectedSize = selected?.estimatedSizeBytes ?? selected?.download?.sizeBytes ?? null
  const dependencies = pkg.dependencies
  const allItems = catalogueQuery.data ?? []
  const recent = (historyQuery.data ?? []).filter((record) => record.packageId === pkg.id).slice(0, 5)
  const dependents = allItems.filter((candidate) =>
    candidate.package.dependencies.some((dependency) => dependency.packageId === pkg.id)
  )

  const openPlan = (version?: string): void => {
    setPlanRequests([{ packageId: pkg.id, version }])
  }

  return (
    <div className="animate-fade-in space-y-5">
      <BackLink />

      <Card className="overflow-hidden">
        <div className="relative">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.08] via-transparent to-transparent" />
          <CardContent className="relative flex flex-col gap-5 p-6 lg:flex-row">
            <SoftwareIconTile icon={pkg.icon} size="lg" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{categoryLabels[pkg.category] ?? pkg.category}</Badge>
                <Badge variant="secondary">{methodLabels[pkg.installationMethod] ?? pkg.installationMethod}</Badge>
                {pkg.advanced ? <Badge variant="warning">Advanced</Badge> : null}
                {installed ? <StatusBadge status="installed" label={`Installed ${installed.version}`} /> : null}
                {item.updateAvailable ? <StatusBadge status="update" label={`${item.availableVersion} available`} /> : null}
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">{pkg.name}</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {pkg.publisher} · {pkg.license} · id <span className="font-mono">{pkg.id}</span>
              </p>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                {pkg.longDescription ?? pkg.description}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {pkg.tags.map((tag) => (
                  <Badge key={tag} variant="muted" className="normal-case tracking-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Globe className="size-3.5" />
                  {pkg.versions.length} version{pkg.versions.length === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3.5" />
                  {pkg.dependencies.length} dependencies
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Terminal className="size-3.5" />
                  {pkg.scope === 'system' ? 'System scope' : 'User scope'}
                </span>
                <button
                  type="button"
                  onClick={() => void api.system.openExternal(pkg.homepage)}
                  className="inline-flex items-center gap-1.5 text-primary hover:underline"
                >
                  <ExternalLink className="size-3.5" />
                  Homepage
                </button>
                {pkg.documentationUrl ? (
                  <button
                    type="button"
                    onClick={() => void api.system.openExternal(pkg.documentationUrl as string)}
                    className="inline-flex items-center gap-1.5 text-primary hover:underline"
                  >
                    <BookOpen className="size-3.5" />
                    Documentation
                  </button>
                ) : null}
              </div>
            </div>

            <div className="w-full shrink-0 lg:w-[290px]">
              <div className="rounded-xl border border-border/80 bg-secondary/25 p-4">
                {recipe ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <BookOpen className="size-4 text-primary" />
                      Guided project setup
                    </div>
                    <p className="text-[11px] leading-5 text-muted-foreground">
                      {pkg.projectRecipe?.summary ?? 'This package is configured inside an existing project.'}
                    </p>
                    <Button className="w-full" onClick={() => setRecipeOpen(true)}>
                      <Play />
                      Show setup steps
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Version
                      </p>
                      <Select
                        value={selected?.version ?? ''}
                        onValueChange={(value) => setSelectedVersion(value)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a version" />
                        </SelectTrigger>
                        <SelectContent>
                          {versions.map((version) => (
                            <SelectItem key={version.version} value={version.version}>
                              <span className="flex items-center gap-2">
                                <span className="font-mono">{version.version}</span>
                                {version.channel === 'lts' ? <span className="text-[10px] text-success">LTS</span> : null}
                                {version.isDefault ? <span className="text-[10px] text-muted-foreground">default</span> : null}
                                {installedVersions.has(version.version) ? (
                                  <span className="text-[10px] text-primary">installed</span>
                                ) : null}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5 text-[11px]">
                      <InstallFact label="Method" value={methodLabels[pkg.installationMethod] ?? pkg.installationMethod} />
                      <InstallFact label="Download" value={formatBytes(selectedSize)} />
                      <InstallFact label="Elevation" value={pkg.requiresAdmin ? 'Administrator required' : 'Not required'} />
                      <InstallFact label="Restart" value={pkg.requiresRestart ? 'Windows restart' : 'None expected'} />
                      <InstallFact label="Environment" value={`${pkg.environment.length} change(s)`} />
                    </div>

                    <Button
                      className="w-full"
                      onClick={() => openPlan(selected?.version)}
                      disabled={!selected}
                    >
                      {item.updateAvailable ? <ArrowUpCircle /> : <Download />}
                      {installed
                        ? item.updateAvailable
                          ? `Update to ${item.availableVersion}`
                          : 'Reinstall selected version'
                        : 'Install'}
                    </Button>

                    {installed ? (
                      <p className="text-center text-[10px] leading-4 text-muted-foreground">
                        Installed {installed.version}
                        {installed.detectedVersion && installed.detectedVersion !== installed.version
                          ? ` · detected ${installed.detectedVersion}`
                          : ''}
                        {installed.isActive ? ' · active' : ''}
                      </p>
                    ) : null}
                    <p className="flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
                      <ShieldCheck className="mt-0.5 size-3 shrink-0 text-success" />
                      Downloads use official HTTPS sources and are verified against the registry checksum before use.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">Versions ({pkg.versions.length})</TabsTrigger>
          <TabsTrigger value="technical">Technical details</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies ({dependencies.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>About this package</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs leading-6 text-muted-foreground">{pkg.longDescription ?? pkg.description}</p>

                {pkg.caveats.length > 0 ? (
                  <div className="rounded-lg border border-warning/25 bg-warning/5 px-3.5 py-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
                      <TriangleAlert className="size-3.5" />
                      Before you install
                    </p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] leading-5 text-muted-foreground">
                      {pkg.caveats.map((caveat, index) => (
                        <li key={index}>{caveat}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {recipe && pkg.projectRecipe ? (
                  <div className="overflow-hidden rounded-lg border border-border/70">
                    {pkg.projectRecipe.commands.map((command, index) => (
                      <div key={index} className={index > 0 ? 'border-t border-border/60' : ''}>
                        <div className="flex items-center justify-between gap-2 bg-secondary/30 px-3 py-1.5">
                          <span className="text-[11px] font-medium">{command.label}</span>
                          <CopyButton value={command.command} />
                        </div>
                        <pre className="overflow-x-auto bg-background/60 px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85">
                          {command.command}
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Environment impact
                  </p>
                  {pkg.environment.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      This package does not modify environment variables or PATH.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {pkg.environment.map((entry, index) => (
                        <li
                          key={`${entry.name}-${index}`}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-1.5 text-[11px]"
                        >
                          <Badge variant="outline">{entry.kind === 'path' ? 'PATH' : 'Variable'}</Badge>
                          <span className="font-mono text-foreground/90">{entry.name}</span>
                          <span className="min-w-0 truncate font-mono text-muted-foreground">{entry.valueTemplate}</span>
                          <Badge variant="muted" className="ml-auto">
                            {entry.scope}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Verification</CardTitle>
                </CardHeader>
                <CardContent>
                  {pkg.verification.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No automatic checks are defined.</p>
                  ) : (
                    <ul className="space-y-2">
                      {pkg.verification.map((check) => (
                        <li key={check.id} className="flex items-start gap-2 text-[11px]">
                          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                          <div>
                            <p className="font-medium text-foreground/90">{check.label}</p>
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {check.command ?? check.kind}
                              {check.args?.length ? ` ${check.args.join(' ')}` : ''}
                            </p>
                            {check.optional ? <p className="text-[10px] text-muted-foreground/70">Optional</p> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Recent operations</CardTitle>
                </CardHeader>
                <CardContent>
                  {recent.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No operations recorded for this package yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {recent.map((record) => (
                        <li key={record.id}>
                          <Link
                            to="/history"
                            className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-secondary/50"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-foreground/90">
                                {record.version ?? 'latest'} · {methodLabels[record.method] ?? record.method}
                              </span>
                              <span className="block text-[10px] text-muted-foreground">
                                {formatRelative(record.startedAt)} · {formatDuration(record.startedAt, record.finishedAt)}
                              </span>
                            </span>
                            <StatusBadge status={record.status} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button variant="ghost" size="sm" asChild className="mt-2 w-full">
                    <Link to="/history">
                      <History />
                      Open history
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="versions">
          <Card>
            <CardHeader>
              <CardTitle>Available versions</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-y border-border/70 bg-secondary/25 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      <th className="px-5 py-2 font-medium">Version</th>
                      <th className="px-3 py-2 font-medium">Channel</th>
                      <th className="px-3 py-2 font-medium">Method</th>
                      <th className="px-3 py-2 font-medium">Size</th>
                      <th className="px-3 py-2 font-medium">State</th>
                      <th className="px-5 py-2 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {versions.map((version) => {
                      const isInstalled = installedVersions.has(version.version)
                      const isActive = item.installations.some(
                        (record) => record.version === version.version && record.isActive
                      )
                      return (
                        <tr key={version.version} className="transition-colors hover:bg-secondary/20">
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-foreground">{version.version}</span>
                              {version.isDefault ? <Badge variant="default">Default</Badge> : null}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {version.channel === 'lts' ? 'LTS' : 'Stable'}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {methodLabels[pkg.installationMethod] ?? pkg.installationMethod}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {formatBytes(version.estimatedSizeBytes ?? version.download?.sizeBytes ?? null)}
                          </td>
                          <td className="px-3 py-2.5">
                            {isActive ? (
                              <Badge variant="success">Active</Badge>
                            ) : isInstalled ? (
                              <Badge variant="success">Installed</Badge>
                            ) : (
                              <Badge variant="muted">Not installed</Badge>
                            )}
                          </td>
                          <td className="px-5 py-2.5 text-right">
                            <Button
                              size="sm"
                              variant={isActive ? 'ghost' : 'outline'}
                              onClick={() => openPlan(version.version)}
                              disabled={recipe}
                            >
                              {isInstalled ? 'Reinstall' : 'Install'}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {pkg.supportsVersionSwitching && installedVersions.size > 1 ? (
                <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 text-[11px] text-muted-foreground">
                  <span>Multiple versions are installed and this package supports switching between them.</span>
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/versions">Open Version Manager</Link>
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="technical">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Package facts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <DetailRow label="Package id" value={pkg.id} mono />
                <DetailRow
                  label="Canonical identity"
                  value={identity ? `${identity.officialName} (${identity.id})` : '—'}
                />
                <DetailRow label="Upstream versions" value={versionSourceLabel} />
                <DetailRow label="Commands" value={identity?.executables.join(', ') || '—'} mono />
                <DetailRow label="Publisher" value={pkg.publisher} />
                <DetailRow label="License" value={pkg.license} />
                <DetailRow label="Category" value={categoryLabels[pkg.category] ?? pkg.category} />
                <DetailRow label="Installation method" value={methodLabels[pkg.installationMethod] ?? pkg.installationMethod} />
                <DetailRow label="Install scope" value={pkg.scope === 'system' ? 'System (all users)' : 'User'} />
                <DetailRow label="Package manager id" value={pkg.packageManagerId ?? '—'} mono />
                <DetailRow label="Architectures" value={pkg.supportedArchitectures.join(', ')} />
                <DetailRow label="Windows versions" value={pkg.supportedWindowsVersions.join(', ')} />
                <DetailRow label="Administrator" value={pkg.requiresAdmin ? 'Required' : 'Not required'} />
                <DetailRow label="Restart" value={pkg.requiresRestart ? 'Restart required' : 'None expected'} />
                <DetailRow label="Version switching" value={pkg.supportsVersionSwitching ? 'Supported' : 'Not supported'} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Detection &amp; removal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <DetailRow
                  label="Detection command"
                  value={
                    pkg.detection.command
                      ? `${pkg.detection.command} ${pkg.detection.args.join(' ')}`.trim()
                      : 'Registry and known paths'
                  }
                  mono
                />
                <DetailRow label="Known paths" value={pkg.detection.knownPaths.join(' · ') || '—'} mono />
                <DetailRow label="Install directory" value={pkg.installDirectoryTemplate ?? 'Managed tools directory'} mono />
                <DetailRow label="Expected executables" value={pkg.expectedExecutables.join(', ') || '—'} mono />
                <DetailRow
                  label="Uninstall method"
                  value={pkg.uninstall ? humanizeMethod(pkg.uninstall.method) : 'Directory-based removal'}
                />
                <DetailRow
                  label="User data"
                  value={pkg.uninstall?.keepData === false ? 'May remove data' : 'Preserved by default'}
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="dependencies" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Dependencies</CardTitle>
            </CardHeader>
            <CardContent>
              {dependencies.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  This package has no declared dependencies.
                </p>
              ) : (
                <ul className="space-y-2">
                  {dependencies.map((dependency) => {
                    const target = allItems.find((candidate) => candidate.package.id === dependency.packageId)
                    return (
                      <li
                        key={dependency.packageId}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2.5"
                      >
                        {target ? <SoftwareIconTile icon={target.package.icon} size="sm" /> : null}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium">
                            {target?.package.name ?? dependency.packageId}
                            {dependency.minVersion ? (
                              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                                ≥ {dependency.minVersion}
                              </span>
                            ) : null}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {dependency.reason ?? (dependency.kind === 'required' ? 'Required dependency' : 'Optional dependency')}
                          </p>
                        </div>
                        <Badge variant={dependency.kind === 'required' ? 'warning' : 'outline'}>
                          {dependency.kind}
                        </Badge>
                        {target?.installed ? <StatusBadge status="installed" label="Installed" /> : null}
                        {target ? (
                          <Button variant="ghost" size="icon-sm" asChild>
                            <Link to={`/discover/${target.package.id}`} aria-label={`Open ${target.package.name}`}>
                              <ChevronRight />
                            </Link>
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Required by</CardTitle>
            </CardHeader>
            <CardContent>
              {dependents.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No other registry package depends on this one.</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {dependents.map((dependent) => (
                    <li key={dependent.package.id}>
                      <Link
                        to={`/discover/${dependent.package.id}`}
                        className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs transition-colors hover:border-primary/30"
                      >
                        <SoftwareIconTile icon={dependent.package.icon} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{dependent.package.name}</span>
                        <ChevronRight className="size-3.5 text-muted-foreground/50" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />
      <RecipeDialog pkg={recipeOpen ? pkg : null} onOpenChange={(open) => !open && setRecipeOpen(false)} />
    </div>
  )
}

function BackLink(): ReactNode {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/discover">
          <ArrowLeft />
          Discover Software
        </Link>
      </Button>
      <ChevronRight className="size-3" />
      <span>Package details</span>
    </div>
  )
}

function InstallFact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right text-foreground/85">{value}</span>
    </div>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-all text-right text-[11px] text-foreground/85 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

const versionSourceLabels: Record<string, string> = {
  nodejs: 'Node.js release index',
  python: 'Python release index',
  go: 'Go download index',
  php: 'PHP for Windows releases',
  flutter: 'Flutter release archives',
  dart: 'Dart SDK archive',
  github: 'Official GitHub releases',
  winget: 'WinGet manifest',
  none: 'DevForge package manifest'
}

function humanizeMethod(method: string): string {
  if (method === 'winget') return 'WinGet uninstall'
  if (method === 'directory') return 'Managed directory removal'
  return 'Uninstall command'
}
