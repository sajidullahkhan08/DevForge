import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  Download,
  FileDown,
  FileUp,
  Info,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'
import type {
  CatalogueItem,
  EnvironmentProfile,
  InstallRequest,
  ProfileInput
} from '@shared/types'
import { api } from '@/lib/api'
import { categoryLabels } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue, useProfiles } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { SoftwareIcon } from '@/lib/icons'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PlanDialog } from '@/components/common/PlanDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export default function EnvironmentsPage(): ReactNode {
  const queryClient = useQueryClient()
  const profilesQuery = useProfiles()
  const catalogueQuery = useCatalogue()
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])
  const [editingProfile, setEditingProfile] = useState<EnvironmentProfile | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EnvironmentProfile | null>(null)

  const catalogue = catalogueQuery.data ?? []
  const packageMap = useMemo(
    () => new Map(catalogue.map((item) => [item.package.id, item])),
    [catalogue]
  )

  const duplicateMutation = useMutation({
    mutationFn: (profileId: string) => api.profiles.duplicate(profileId),
    onSuccess: (profile) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      notifySuccess('Profile duplicated', `${profile.name} is now available as an editable copy.`)
    },
    onError: notifyError
  })

  const exportMutation = useMutation({
    mutationFn: (profileId: string) => api.profiles.exportManifest(profileId),
    onSuccess: (result) => {
      if (result.canceled || !result.path) return
      notifySuccess('Environment manifest exported', `Pinned versions were written to ${result.path}.`)
    },
    onError: notifyError
  })

  const importMutation = useMutation({
    mutationFn: () => api.profiles.importManifest(),
    onSuccess: (result) => {
      if (result.canceled || !result.profile) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      const warningNote = result.warnings.length > 0 ? ` ${result.warnings.length} warning(s) were reported.` : ''
      notifySuccess('Environment imported', `${result.profile.name} is ready to review and install.${warningNote}`)
    },
    onError: notifyError
  })

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => api.profiles.remove(profileId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      notifySuccess('Profile removed', 'The custom profile was deleted. Installed software is unchanged.')
      setDeleteTarget(null)
    },
    onError: notifyError
  })

  const openCreate = (): void => {
    setEditingProfile(null)
    setDialogOpen(true)
  }

  const openEdit = (profile: EnvironmentProfile): void => {
    setEditingProfile(profile)
    setDialogOpen(true)
  }

  const installProfile = (profile: EnvironmentProfile): void => {
    const required = profile.components.filter((component) => !component.optional)
    const components = required.length > 0 ? required : profile.components
    setPlanRequests(
      components.map((component) => ({
        packageId: component.packageId,
        version: component.preferredVersion ?? undefined
      }))
    )
  }

  const missingFor = (profile: EnvironmentProfile): number =>
    profile.components.filter(
      (component) => !component.optional && !packageMap.get(component.packageId)?.installed
    ).length

  const profiles = profilesQuery.data ?? []

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Environments"
        title="Development Environments"
        description="Curated profiles bundle the tools a workflow needs. DevForge builds one dependency-aware plan and installs the profile as a serialized operation."
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending}
            >
              {importMutation.isPending ? <Loader2 className="animate-spin" /> : <FileUp />}
              Import
            </Button>
            <Button size="sm" onClick={openCreate} disabled={catalogue.length === 0}>
              <Plus />
              New profile
            </Button>
          </div>
        }
      />

      {profilesQuery.isError ? (
        <ErrorState error={profilesQuery.error} onRetry={() => void profilesQuery.refetch()} />
      ) : profilesQuery.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-[248px] rounded-xl" />
          ))}
        </div>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No environment profiles available"
          description="Built-in profiles are loaded from the packaged registry. You can also create a custom profile from the catalogue."
          action={
            <Button size="sm" onClick={openCreate} disabled={catalogue.length === 0}>
              <Plus />
              Create a profile
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {profiles.map((profile) => {
            const missing = missingFor(profile)
            return (
              <Card key={profile.id} className="flex flex-col transition-colors hover:border-border">
                <CardContent className="flex flex-1 flex-col p-4">
                  <div className="flex items-start gap-3">
                    <SoftwareIconTile icon={profile.icon} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h2 className="text-sm font-semibold tracking-tight">{profile.name}</h2>
                        {profile.isBuiltin ? <Badge variant="outline">Built-in</Badge> : <Badge variant="secondary">Custom</Badge>}
                        {missing === 0 ? (
                          <Badge variant="success">Ready</Badge>
                        ) : (
                          <Badge variant="warning">{missing} missing</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{profile.audience}</p>
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">{profile.description}</p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {profile.components.map((component) => {
                      const pkg = packageMap.get(component.packageId)
                      return (
                        <Link
                          key={component.packageId}
                          to={`/discover/${component.packageId}`}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                            pkg?.installed
                              ? 'border-success/25 bg-success/10 text-success hover:bg-success/15'
                              : 'border-border bg-secondary/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
                          )}
                        >
                          {pkg ? <SoftwareIcon icon={pkg.package.icon} size={11} /> : null}
                          {pkg?.package.name ?? component.packageId}
                          {component.optional ? <span className="opacity-60">optional</span> : null}
                        </Link>
                      )
                    })}
                  </div>

                  {profile.notes.length > 0 ? (
                    <div className="mt-3 flex items-start gap-1.5 rounded-md bg-secondary/25 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                      <Info className="mt-0.5 size-3 shrink-0" />
                      <span className="line-clamp-2">{profile.notes[0]}</span>
                    </div>
                  ) : null}

                  <div className="mt-auto flex items-center gap-1.5 pt-4">
                    <Button size="sm" className="flex-1" onClick={() => installProfile(profile)}>
                      <Download />
                      {missing === 0 ? 'Reinstall profile' : 'Install profile'}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Export pinned environment manifest"
                      aria-label="Export pinned environment manifest"
                      onClick={() => exportMutation.mutate(profile.id)}
                      disabled={exportMutation.isPending}
                    >
                      {exportMutation.isPending ? <Loader2 className="animate-spin" /> : <FileDown />}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Duplicate profile"
                      aria-label="Duplicate profile"
                      onClick={() => duplicateMutation.mutate(profile.id)}
                      disabled={duplicateMutation.isPending}
                    >
                      <Copy />
                    </Button>
                    {!profile.isBuiltin ? (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Edit profile"
                          onClick={() => openEdit(profile)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Delete profile"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(profile)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground/70">
                    {profile.components.length} package(s) · optional components are not installed automatically
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Card className="border-primary/20 bg-primary/[0.04]">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </div>
          <div className="text-[11px] leading-5 text-muted-foreground">
            <p className="text-xs font-medium text-foreground">Profiles are plans, not shortcuts</p>
            <p className="mt-0.5">
              DevForge resolves dependencies, checks disk space and architecture support, then shows you every step
              before anything runs. Already-installed packages are skipped instead of being overwritten.
            </p>
          </div>
        </CardContent>
      </Card>

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />

      <ProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editingProfile}
        catalogue={catalogue}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this profile?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" will be removed from your custom profiles. Software installed through the profile stays installed.`
            : ''
        }
        confirmLabel="Delete profile"
        destructive
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
    </div>
  )
}

interface ProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: EnvironmentProfile | null
  catalogue: CatalogueItem[]
}

interface ComponentDraft {
  packageId: string
  optional: boolean
  preferredVersion: string | null
}

function ProfileDialog({ open, onOpenChange, profile, catalogue }: ProfileDialogProps): ReactNode {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [audience, setAudience] = useState('')
  const [icon, setIcon] = useState('nodedotjs')
  const [components, setComponents] = useState<ComponentDraft[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    setName(profile ? `${profile.name}` : '')
    setDescription(profile?.description ?? '')
    setAudience(profile?.audience ?? '')
    setIcon(profile?.icon ?? 'nodedotjs')
    setComponents(
      profile
        ? profile.components.map((component) => ({
            packageId: component.packageId,
            optional: component.optional,
            preferredVersion: component.preferredVersion
          }))
        : []
    )
    setSearch('')
  }, [open, profile])

  const mutation = useMutation({
    mutationFn: (input: ProfileInput) =>
      profile ? api.profiles.update(profile.id, input) : api.profiles.create(input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      notifySuccess(profile ? 'Profile updated' : 'Profile created', `${saved.name} is ready to use.`)
      onOpenChange(false)
    },
    onError: notifyError
  })

  const iconOptions = useMemo(
    () => [...new Set(catalogue.map((item) => item.package.icon))].sort(),
    [catalogue]
  )

  const filteredCatalogue = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return catalogue
    return catalogue.filter(
      (item) =>
        item.package.name.toLowerCase().includes(query) ||
        item.package.id.includes(query) ||
        item.package.category.includes(query)
    )
  }, [catalogue, search])

  const toggle = (packageId: string): void => {
    setComponents((previous) =>
      previous.some((component) => component.packageId === packageId)
        ? previous.filter((component) => component.packageId !== packageId)
        : [...previous, { packageId, optional: false, preferredVersion: null }]
    )
  }

  const toggleOptional = (packageId: string): void => {
    setComponents((previous) =>
      previous.map((component) =>
        component.packageId === packageId ? { ...component, optional: !component.optional } : component
      )
    )
  }

  const submit = (): void => {
    if (!name.trim() || !description.trim() || !audience.trim()) {
      notifyError('Name, audience and description are required.')
      return
    }
    if (components.length === 0) {
      notifyError('Select at least one package for this profile.')
      return
    }
    mutation.mutate({
      name: name.trim(),
      description: description.trim(),
      audience: audience.trim(),
      icon,
      components: components.map((component) => ({
        packageId: component.packageId,
        optional: component.optional,
        preferredVersion: component.preferredVersion
      }))
    })
  }

  const requiredCount = components.filter((component) => !component.optional).length

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="border-b border-border/70 p-6 pb-4">
          <DialogTitle>{profile ? 'Edit profile' : 'Create a profile'}</DialogTitle>
          <DialogDescription>
            Profiles are reusable sets of packages. DevForge validates each package against the registry.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[58vh] overflow-y-auto">
          <div className="grid gap-4 p-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Full-stack TypeScript"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-audience">Audience</Label>
              <Input
                id="profile-audience"
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="Web developers"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Icon</Label>
              <div className="flex items-center gap-2">
                <SoftwareIconTile icon={icon} size="sm" />
                <Select value={icon} onValueChange={setIcon}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {iconOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="profile-description">Description</Label>
              <Textarea
                id="profile-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this environment is for and which workflows it supports."
                maxLength={400}
                className="min-h-[64px]"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Packages ({components.length})</Label>
                <div className="relative w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filter packages…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>
              <ScrollArea className="h-[240px] rounded-lg border border-border/70">
                <div className="space-y-1 p-1.5">
                  {filteredCatalogue.map((item) => {
                    const component = components.find((candidate) => candidate.packageId === item.package.id)
                    const selected = Boolean(component)
                    return (
                      <div
                        key={item.package.id}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition-colors',
                          selected ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:bg-secondary/50'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggle(item.package.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left"
                        >
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded border',
                              selected
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-input bg-background/60'
                            )}
                          >
                            {selected ? <Check className="size-3" /> : null}
                          </span>
                          <SoftwareIconTile icon={item.package.icon} size="sm" className="size-7 rounded-md" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">{item.package.name}</span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {categoryLabels[item.package.category] ?? item.package.category} · {item.package.id}
                            </span>
                          </span>
                          {item.installed ? <Badge variant="success">Installed</Badge> : null}
                        </button>
                        {selected ? (
                          <div className="flex shrink-0 items-center gap-1.5 pr-1">
                            <span className="text-[10px] text-muted-foreground">Optional</span>
                            <Switch
                              checked={component?.optional ?? false}
                              onCheckedChange={() => toggleOptional(item.package.id)}
                              aria-label={`Mark ${item.package.name} as optional`}
                              className="scale-90"
                            />
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                  {filteredCatalogue.length === 0 ? (
                    <p className="py-6 text-center text-[11px] text-muted-foreground">No packages match.</p>
                  ) : null}
                </div>
              </ScrollArea>
              <p className="text-[10px] text-muted-foreground">
                {requiredCount} required · {components.length - requiredCount} optional
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <Check />}
            {profile ? 'Save changes' : 'Create profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
