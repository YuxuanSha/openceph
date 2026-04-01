"""
openceph-runtime — Python runtime library for OpenCeph skill_tentacle.

Provides IPC communication, LLM Gateway access, Agent Loop,
logging, and state management for tentacle developers.
"""

from .ipc import IpcClient
from .llm import LlmClient, LlmResponse, ToolCall
from .agent import AgentLoop
from .tools import ToolRegistry, load_tools
from .logger import TentacleLogger
from .config import TentacleConfig
from .state import StateDB

__version__ = "1.0.0"

__all__ = [
    "IpcClient",
    "LlmClient",
    "LlmResponse",
    "ToolCall",
    "AgentLoop",
    "ToolRegistry",
    "load_tools",
    "TentacleLogger",
    "TentacleConfig",
    "StateDB",
]
