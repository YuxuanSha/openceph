/**
 * Set up global HTTP proxy for Node.js fetch/undici.
 * Must be called BEFORE any API requests are made.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY is set,
 * this makes Node's global fetch use the proxy — matching curl behavior.
 */
export async function setupGlobalProxy(): Promise<void> {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy

  if (!proxyUrl) return

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici")
    setGlobalDispatcher(new EnvHttpProxyAgent())
    console.log(`🌐 Proxy enabled: ${proxyUrl}`)
  } catch (err: any) {
    console.warn(`⚠️ Failed to set up proxy dispatcher: ${err.message}`)
  }
}
