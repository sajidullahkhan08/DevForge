import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy copy path.
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

interface CopyButtonProps {
  value: string
  label?: string
  className?: string
  size?: 'sm' | 'icon' | 'icon-sm'
}

export function CopyButton({ value, label, className, size = 'icon-sm' }: CopyButtonProps): ReactNode {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    const success = await copyText(value)
    if (!success) {
      toast.error('Could not copy to the clipboard.')
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className={cn(label ? 'px-2' : '', className)}
      onClick={() => void handleCopy()}
      aria-label={label ?? 'Copy'}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      {label ? <span>{copied ? 'Copied' : label}</span> : null}
    </Button>
  )
}
