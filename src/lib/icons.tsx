import type { ReactElement } from 'react'
import { Terminal } from 'lucide-react'
import {
  siApachemaven,
  siCmake,
  siComposer,
  siCplusplus,
  siDart,
  siDjango,
  siDocker,
  siDotnet,
  siFlask,
  siFlutter,
  siGit,
  siGithub,
  siGnu,
  siGo,
  siGradle,
  siKotlin,
  siLlvm,
  siMongodb,
  siMysql,
  siNodedotjs,
  siOpenjdk,
  siPhp,
  siPostgresql,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSpringboot
} from 'simple-icons'

interface BrandIcon {
  path: string
  color: string
}

const brandIcons: Record<string, BrandIcon> = {
  python: { path: siPython.path, color: '#3776AB' },
  openjdk: { path: siOpenjdk.path, color: '#EDA44A' },
  nodedotjs: { path: siNodedotjs.path, color: '#5FA04E' },
  go: { path: siGo.path, color: '#00ADD8' },
  rust: { path: siRust.path, color: '#E7E7E7' },
  dotnet: { path: siDotnet.path, color: '#8A7DFF' },
  postgresql: { path: siPostgresql.path, color: '#5B8CF0' },
  mysql: { path: siMysql.path, color: '#58A6C9' },
  mongodb: { path: siMongodb.path, color: '#5CC45C' },
  git: { path: siGit.path, color: '#F05B47' },
  github: { path: siGithub.path, color: '#E6EDF3' },
  docker: { path: siDocker.path, color: '#3DA5F4' },
  gnu: { path: siGnu.path, color: '#E06666' },
  cmake: { path: siCmake.path, color: '#59A5E8' },
  composer: { path: siComposer.path, color: '#885630' },
  apachemaven: { path: siApachemaven.path, color: '#E0556F' },
  django: { path: siDjango.path, color: '#44B78B' },
  flask: { path: siFlask.path, color: '#3BABC3' },
  react: { path: siReact.path, color: '#61DAFB' },
  springboot: { path: siSpringboot.path, color: '#7CC96B' },
  kotlin: { path: siKotlin.path, color: '#A97BFF' },
  flutter: { path: siFlutter.path, color: '#54C5F8' },
  dart: { path: siDart.path, color: '#40C4FF' },
  php: { path: siPhp.path, color: '#A7A4E0' },
  ruby: { path: siRuby.path, color: '#F05B47' },
  llvm: { path: siLlvm.path, color: '#B8C0CC' },
  cplusplus: { path: siCplusplus.path, color: '#6AA9FF' },
  gradle: { path: siGradle.path, color: '#63C7B2' }
}

export function isBrandIcon(icon: string): boolean {
  return icon in brandIcons
}

export function brandIconColor(icon: string): string {
  return brandIcons[icon]?.color ?? 'hsl(var(--muted-foreground))'
}

interface SoftwareIconProps {
  icon: string
  size?: number
  className?: string
}

export function SoftwareIcon({ icon, size = 24, className }: SoftwareIconProps): ReactElement {
  const brand = brandIcons[icon]
  if (!brand) {
    return <Terminal width={size} height={size} strokeWidth={1.7} className={className} aria-hidden="true" />
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={icon}
      className={className}
      fill={brand.color}
    >
      <path d={brand.path} />
    </svg>
  )
}
