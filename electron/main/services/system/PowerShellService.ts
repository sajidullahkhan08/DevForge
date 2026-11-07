import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../errors'
import { ProcessExecutor } from '../process/ProcessExecutor'

export interface PowerShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Runs PowerShell with a fully encoded command. User-provided values are never
 * interpolated into script text: they are passed as a base64 JSON payload via
 * an environment variable.
 */
export class PowerShellService {
  private readonly executor: ProcessExecutor
  private readonly executable: string

  constructor(executor: ProcessExecutor) {
    this.executor = executor
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    this.executable = existsSync(candidate) ? candidate : 'powershell.exe'
  }

  async run(script: string, payload?: unknown, timeoutMs = 60000): Promise<PowerShellResult> {
    const preamble = "$ErrorActionPreference = 'Stop'\n"
    const encoded = Buffer.from(preamble + script, 'utf16le').toString('base64')
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DEVFORGE_PAYLOAD: payload === undefined ? '' : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    }
    const result = await this.executor.run(
      this.executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env, timeoutMs, maxOutputBytes: 2 * 1024 * 1024 }
    )
    if (result.exitCode !== 0) {
      throw new AppError('INTERNAL', 'A Windows system operation failed.', {
        hint: 'Try again. If the problem persists, check the DevForge logs.',
        details: (result.stderr || result.stdout).slice(-4000)
      })
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  async runJson<T>(script: string, payload?: unknown, timeoutMs = 60000): Promise<T> {
    const result = await this.run(script, payload, timeoutMs)
    const text = result.stdout.trim()
    if (!text) return null as T
    const start = Math.min(
      ...['{', '[']
        .map((character) => text.indexOf(character))
        .filter((index) => index >= 0)
    )
    const candidate = Number.isFinite(start) && start >= 0 ? text.slice(start) : text
    try {
      return JSON.parse(candidate) as T
    } catch (error) {
      throw new AppError('INTERNAL', 'Could not read the Windows system response.', {
        details: text.slice(-4000)
      })
    }
  }
}

export const powershellScripts = {
  readPayload: `
    $payload = if ($env:DEVFORGE_PAYLOAD) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json } else { $null }
  `,
  isElevated: `
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'true' } else { 'false' }
  `,
  powershellVersion: `$PSVersionTable.PSVersion.ToString()`,
  authenticodeSignature: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    $signature = Get-AuthenticodeSignature -LiteralPath $payload.path
    $certificate = $signature.SignerCertificate
    [pscustomobject]@{
      status = [string]$signature.Status
      subject = if ($certificate) { [string]$certificate.Subject } else { '' }
      thumbprint = if ($certificate) { [string]$certificate.Thumbprint } else { '' }
    } | ConvertTo-Json -Compress
  `,
  readEnvironment: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    $scope = $payload.scope
    if ($scope -eq 'user') { $path = 'HKEY_CURRENT_USER\\Environment' }
    elseif ($scope -eq 'system') { $path = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' }
    else { throw "Unknown environment scope" }

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($scope -eq 'system') {
      $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', $false)
    }
    if (-not $key) { @() | ConvertTo-Json -Compress; exit 0 }

    $items = @()
    foreach ($name in $key.GetValueNames()) {
      $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $items += [pscustomobject]@{
        name = $name
        value = [string]$value
        kind = $key.GetValueKind($name).ToString()
      }
    }
    $key.Close()
    @($items) | ConvertTo-Json -Compress
  `,
  writeEnvironment: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($payload.scope -eq 'user') {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    } elseif ($payload.scope -eq 'system') {
      if (-not $isAdmin) { throw 'Administrator permission is required to modify system environment variables.' }
      $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', $true)
    } else {
      throw 'Unknown environment scope'
    }
    if (-not $key) { throw 'Could not open the environment registry key.' }

    if ($payload.delete) {
      $key.DeleteValue($payload.name, $false)
    } else {
      $kind = [Microsoft.Win32.RegistryValueKind]::String
      if ($payload.expandable) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue($payload.name, [string]$payload.value, $kind)
    }
    $key.Close()
    'ok'
  `,
  broadcastEnvironmentChange: `
    $signature = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    try {
      $type = Add-Type -Namespace DevForge -Name NativeEnvironment -MemberDefinition $signature -PassThru -ErrorAction Stop
      $result = [UIntPtr]::Zero
      [void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
      'broadcast'
    } catch {
      'not-broadcast'
    }
  `,
  scanUninstallRegistry: `
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $items = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName } |
      Select-Object DisplayName, DisplayVersion, InstallLocation, Publisher
    @($items) | ConvertTo-Json -Compress
  `,
  serviceInfo: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    $services = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $payload.pattern })
    if ($services.Count -eq 0) {
      @{ exists = $false } | ConvertTo-Json -Compress
    } else {
      $service = $services[0]
      @{ exists = $true; name = $service.Name; status = $service.Status.ToString() } | ConvertTo-Json -Compress
    }
  `,
  diskFree: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    $drive = [System.IO.Path]::GetPathRoot($payload.path)
    $info = New-Object System.IO.DriveInfo($drive)
    [string]$info.AvailableFreeSpace
  `,
  windowsCaption: `
    (Get-CimInstance Win32_OperatingSystem).Caption
  `,
  deleteDirectory: `
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVFORGE_PAYLOAD)) | ConvertFrom-Json
    if (Test-Path -LiteralPath $payload.path) {
      Remove-Item -LiteralPath $payload.path -Recurse -Force
    }
    'removed'
  `
}
