import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import { brainLogger } from "../logger/index.js"

/** Simple result cache: query → { results, timestamp } */
const searchCache = new Map<string, { results: string; ts: number }>()
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

export function createWebTools(): ToolRegistryEntry[] {
  const webSearch: ToolDefinition = {
    name: "web_search",
    label: "Web Search",
    description: "搜索互联网公开信息。注意：不要用来搜索 OpenCeph 内部系统问题（部署失败、触手错误等），这些互联网上搜不到。",
    promptSnippet: "web_search — 搜索网页（DuckDuckGo），结果缓存 15 分钟",
    promptGuidelines: [
      "当用户说「帮我搜一下」「搜索」「查一下」「找一下」时，调用 web_search 工具。",
      "将搜索结果直接在回复中总结给用户，不要调用 send_to_user。",
      "如果上下文中没有搜索结果，不要声称已经搜过了，必须实际调用 web_search。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      max_results: Type.Optional(Type.Number({ description: "最多返回结果数（默认 5）" })),
    }),
    async execute(_id, params: any) {
      const query: string = params.query
      const maxResults: number = params.max_results ?? 5

      // Check cache
      const cacheKey = `${query}:${maxResults}`
      const cached = searchCache.get(cacheKey)
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        brainLogger.info("web_search_cache_hit", { query })
        return { content: [{ type: "text" as const, text: cached.results }], details: undefined }
      }

      brainLogger.info("web_search", { query, max_results: maxResults })

      try {
        // DuckDuckGo HTML search (lite version, easy to parse)
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; OpenCeph/1.0)",
          },
        })

        if (!resp.ok) {
          return { content: [{ type: "text" as const, text: `Search failed: HTTP ${resp.status}` }], details: undefined }
        }

        const html = await resp.text()
        const results = parseDuckDuckGoResults(html, maxResults)

        if (results.length === 0) {
          const text = `No results found for: "${query}"`
          return { content: [{ type: "text" as const, text }], details: undefined }
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n")

        const text = `Search results for "${query}":\n\n${formatted}`

        // Cache result
        searchCache.set(cacheKey, { results: text, ts: Date.now() })

        return { content: [{ type: "text" as const, text }], details: undefined }
      } catch (err: any) {
        brainLogger.error("web_search_error", { query, error: err.message })
        return { content: [{ type: "text" as const, text: `Search error: ${err.message}` }], details: undefined }
      }
    },
  }

  const webFetch: ToolDefinition = {
    name: "web_fetch",
    label: "Web Fetch",
    description: "抓取指定 URL 的网页内容（纯文本）",
    promptSnippet: "web_fetch — 抓取指定 URL 的网页内容",
    parameters: Type.Object({
      url: Type.String({ description: "要抓取的 URL" }),
      max_length: Type.Optional(Type.Number({ description: "最大返回字符数（默认 5000）" })),
    }),
    async execute(_id, params: any) {
      const url: string = params.url
      const maxLength: number = params.max_length ?? 5000

      brainLogger.info("web_fetch", { url })

      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; OpenCeph/1.0)",
          },
          signal: AbortSignal.timeout(15_000),
        })

        if (!resp.ok) {
          return { content: [{ type: "text" as const, text: `Fetch failed: HTTP ${resp.status}` }], details: undefined }
        }

        const html = await resp.text()
        // Strip HTML tags for plain text extraction
        let text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim()

        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + "\n\n[... truncated]"
        }

        return { content: [{ type: "text" as const, text: `Content from ${url}:\n\n${text}` }], details: undefined }
      } catch (err: any) {
        brainLogger.error("web_fetch_error", { url, error: err.message })
        return { content: [{ type: "text" as const, text: `Fetch error: ${err.message}` }], details: undefined }
      }
    },
  }

  return [
    { name: "web_search", description: webSearch.description, group: "web", tool: webSearch },
    { name: "web_fetch", description: webFetch.description, group: "web", tool: webFetch },
  ]
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = []

  // DuckDuckGo HTML lite uses <a class="result__a"> for titles and
  // <a class="result__snippet"> for snippets
  const resultBlocks = html.split(/class="result\s/g).slice(1)

  for (const block of resultBlocks) {
    if (results.length >= max) break

    // Extract title + URL from result__a
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    // Extract snippet from result__snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//)

    if (titleMatch) {
      let url = titleMatch[1]
      // DuckDuckGo redirects through //duckduckgo.com/l/?uddg=URL
      const uddgMatch = url.match(/uddg=([^&]+)/)
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1])
      }

      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim()
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
        : ""

      if (title && url) {
        results.push({ title, url, snippet })
      }
    }
  }

  return results
}
