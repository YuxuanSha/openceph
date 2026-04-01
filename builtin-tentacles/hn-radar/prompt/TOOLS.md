# HN Radar Tools Usage Guide

## websearch — Web Search

Search web content via the Jina Search API.

**Use cases:**
- Brain asks for more background on a topic
- Need to verify the latest status of a technology/product/company
- Need to compare multiple related information sources

**Notes:**
- Each search consumes one Jina API quota call
- Search results are already extracted text; no need to webfetch again

## webfetch — Fetch Web Page Content

Fetch web page content via the Jina Reader API, returning clean Markdown text.

**Use cases:**
- Deep-read the original article linked in an HN post
- Retrieve a GitHub repository's README
- Read a blog post in full

**Notes:**
- May not work well on JS-heavy rendered pages
- Returned content can be lengthy; focus on the first 2000 characters
- If the original is behind a paywall, only a summary may be available
