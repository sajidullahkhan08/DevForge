import { ProxyAgent, type Dispatcher } from 'undici'
import { AppError } from '../errors'

export interface HttpGetOptions {
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
}

export interface HttpResponse {
  ok: boolean
  status: number
  url: string
  text: string
}

export interface HttpClient {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>
}

const defaultTimeoutMs = 12000
const defaultMaxBytes = 8 * 1024 * 1024

/**
 * Minimal HTTPS-only client used by release providers. Redirects are followed
 * but the final URL is re-checked so a provider cannot be redirected onto an
 * insecure host. Response bodies are size-limited before parsing.
 */
export class FetchHttpClient implements HttpClient {
  private dispatcher: { proxy: string; agent: Dispatcher } | null = null

  constructor(private readonly getProxyUrl: () => string = () => '') {}

  private proxyDispatcher(): Dispatcher | undefined {
    const proxy = this.getProxyUrl().trim()
    if (!proxy) return undefined
    if (this.dispatcher?.proxy === proxy) return this.dispatcher.agent
    if (this.dispatcher) void this.dispatcher.agent.close().catch(() => undefined)
    const agent = new ProxyAgent(proxy)
    this.dispatcher = { proxy, agent }
    return agent
  }

  async get(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'Release metadata is only fetched over HTTPS.')
    }

    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    const maxBytes = options.maxBytes ?? defaultMaxBytes
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(parsed, {
        signal: controller.signal,
        redirect: 'follow',
        dispatcher: this.proxyDispatcher(),
        headers: {
          'user-agent': 'DevForge/1.0 (+https://github.com/) release-metadata',
          accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
          ...options.headers
        }
      })

      const finalUrl = new URL(response.url)
      if (finalUrl.protocol !== 'https:') {
        throw new AppError('VALIDATION', 'A release source redirected to an insecure address.')
      }

      const declared = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new AppError('VALIDATION', 'The release metadata response is unexpectedly large.')
      }

      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new AppError('VALIDATION', 'The release metadata response is unexpectedly large.')
      }

      return { ok: response.ok, status: response.status, url: finalUrl.toString(), text }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError('PROCESS_TIMEOUT', `The release source did not respond within ${timeoutMs / 1000} seconds.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
