# Hacker News Algolia API 参考

## 概述

HN Algolia API 是 Hacker News 的公开搜索 API，由 Algolia 提供。无需认证，支持搜索和获取首页内容。

Base URL: `https://hn.algolia.com/api/v1/`

## 常用端点

### 获取首页帖子

```
GET /search?tags=front_page&hitsPerPage=50
```

返回当前 HN 首页的帖子列表。

### 按关键词搜索

```
GET /search?query=rust+async&tags=story&hitsPerPage=20
```

参数说明：
- `query` — 搜索关键词
- `tags` — 过滤标签，常用值：`story`, `comment`, `front_page`, `ask_hn`, `show_hn`
- `hitsPerPage` — 每页返回数量（最大 1000）
- `numericFilters` — 数值过滤，例如 `points>50,num_comments>10`
- `page` — 页码（从 0 开始）

### 按时间排序搜索

```
GET /search_by_date?tags=story&hitsPerPage=30
```

与 `/search` 参数相同，但按时间倒序排列。

## 响应结构

```json
{
  "hits": [
    {
      "objectID": "12345678",
      "title": "Show HN: A new Rust web framework",
      "url": "https://example.com/article",
      "author": "username",
      "points": 150,
      "num_comments": 42,
      "created_at": "2026-03-20T10:30:00.000Z",
      "created_at_i": 1774018200,
      "_tags": ["story", "author_username", "story_12345678"]
    }
  ],
  "nbHits": 1000,
  "page": 0,
  "nbPages": 50,
  "hitsPerPage": 20
}
```

## 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `objectID` | string | 帖子唯一 ID（即 HN item ID） |
| `title` | string | 帖子标题 |
| `url` | string | 外部链接（Ask HN 等帖子可能为空） |
| `author` | string | 发帖人用户名 |
| `points` | number | 帖子得分 |
| `num_comments` | number | 评论数 |
| `created_at` | string | 创建时间（ISO 8601） |
| `_tags` | array | 标签列表 |

## 速率限制

HN Algolia API 没有严格的速率限制文档，但建议：
- 请求间隔不低于 1 秒
- 单次不超过 1000 条结果
- 添加合理的 User-Agent 头

## 本 Skill 的使用方式

本 skill 使用 `/search?tags=front_page` 端点获取首页帖子，通过 `points` 字段进行分数过滤，通过标题和 URL 中的关键词进行话题匹配。
