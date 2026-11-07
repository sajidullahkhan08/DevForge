import type { ReactNode } from 'react'
import { SoftwareIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SoftwareIconTileProps {
  icon: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: { box: 'size-9 rounded-lg', icon: 18 },
  md: { box: 'size-11 rounded-xl', icon: 24 },
  lg: { box: 'size-14 rounded-2xl', icon: 30 }
}

export function SoftwareIconTile({ icon, size = 'md', className }: SoftwareIconTileProps): ReactNode {
  const config = sizes[size]
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center border border-border/80 bg-secondary/50 shadow-inner shadow-black/10',
        config.box,
        className
      )}
    >
      <SoftwareIcon icon={icon} size={config.icon} />
    </div>
  )
}
