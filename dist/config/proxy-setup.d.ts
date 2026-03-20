/**
 * Set up global HTTP proxy for Node.js fetch/undici.
 * Must be called BEFORE any API requests are made.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY is set,
 * this makes Node's global fetch use the proxy — matching curl behavior.
 */
export declare function setupGlobalProxy(): Promise<void>;
