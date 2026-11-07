import type { ComponentType } from 'react'
import {
  Compass,
  GitBranch,
  History,
  Layers,
  LayoutDashboard,
  ListOrdered,
  PackageCheck,
  Settings,
  SlidersHorizontal
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  showQueueBadge?: boolean
}

export interface NavSection {
  label: string
  items: NavItem[]
}

export const navSections: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/discover', label: 'Discover Software', icon: Compass },
      { to: '/environments', label: 'Environments', icon: Layers }
    ]
  },
  {
    label: 'Manage',
    items: [
      { to: '/installed', label: 'Installed Software', icon: PackageCheck },
      { to: '/queue', label: 'Installation Queue', icon: ListOrdered, showQueueBadge: true },
      { to: '/environment-variables', label: 'Environment Variables', icon: SlidersHorizontal },
      { to: '/versions', label: 'Version Manager', icon: GitBranch }
    ]
  },
  {
    label: 'System',
    items: [
      { to: '/history', label: 'Installation History', icon: History },
      { to: '/settings', label: 'Settings', icon: Settings }
    ]
  }
]
