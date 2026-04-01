"""
ToolRegistry — load and manage tool definitions for tentacle agents.
"""

import json
from pathlib import Path
from typing import Optional


class ToolRegistry:
    """Registry for tentacle tool definitions (OpenAI function calling format)."""

    def __init__(self):
        self._tools: list[dict] = []

    def register(self, tool_def: dict) -> None:
        """Register a single tool definition."""
        self._tools.append(tool_def)

    def register_function(
        self,
        name: str,
        description: str,
        parameters: dict,
    ) -> None:
        """Register a tool in OpenAI function format."""
        self._tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": parameters,
            },
        })

    def get_tools(self) -> list[dict]:
        """Return all registered tool definitions."""
        return self._tools

    def load_from_file(self, path: str | Path) -> None:
        """Load tool definitions from a JSON file."""
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, list):
            self._tools.extend(data)
        elif isinstance(data, dict) and "tools" in data:
            self._tools.extend(data["tools"])

    def append_shared_tools(self) -> None:
        """Append Brain-provided shared tools (openceph_* prefixed).

        These tools are forwarded to Brain via IPC when called.
        Per protocol, shared tools include openceph_web_search and openceph_web_fetch.
        """
        shared_tools = [
            {
                "type": "function",
                "function": {
                    "name": "openceph_web_search",
                    "description": "Search the web via Brain's shared web_search tool. Returns search result summaries.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query keywords"},
                            "max_results": {"type": "integer", "description": "Max results to return (default 5)"},
                        },
                        "required": ["query"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "openceph_web_fetch",
                    "description": "Fetch a URL's content via Brain's shared web_fetch tool. Returns plain text.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "description": "URL to fetch"},
                            "max_length": {"type": "integer", "description": "Max chars to return (default 5000)"},
                        },
                        "required": ["url"],
                    },
                },
            },
        ]
        for tool in shared_tools:
            # Avoid duplicates
            existing_names = {t.get("function", {}).get("name") for t in self._tools}
            if tool["function"]["name"] not in existing_names:
                self._tools.append(tool)

    def __len__(self) -> int:
        return len(self._tools)


def load_tools(path: str | Path, include_shared: bool = True) -> list[dict]:
    """Load tool definitions from a JSON file and return them as a list.

    Args:
        path: Path to tools.json file.
        include_shared: If True, also append Brain-provided shared tools (openceph_*).
    """
    registry = ToolRegistry()
    file_path = Path(path)
    if file_path.exists():
        registry.load_from_file(file_path)
    if include_shared:
        registry.append_shared_tools()
    return registry.get_tools()
