"""
AgentLoop — runs an LLM agent loop with tool calling support.

Per protocol: tool calls with `openceph_` prefix are shared tools and must be
forwarded to Brain via IPC instead of executing locally.
"""

import uuid
from typing import Callable, Optional, Any
from .llm import LlmClient, LlmResponse
from .ipc import IpcClient


class AgentLoop:
    """
    Runs an LLM agent loop: send message → get response → if tool_calls,
    execute tools and send results back → repeat until done or max_turns.
    """

    def __init__(
        self,
        system_prompt: str,
        tools: Optional[list[dict]] = None,
        max_turns: int = 20,
        ipc: Optional[IpcClient] = None,
        llm: Optional[LlmClient] = None,
        temperature: float = 0.3,
        model: str = "default",
    ):
        self.system_prompt = system_prompt
        self.tools = tools
        self.max_turns = max_turns
        self.ipc = ipc
        self.llm = llm or LlmClient()
        self.temperature = temperature
        self.model = model

    def run(
        self,
        user_message: str,
        tool_executor: Optional[Callable[[str, dict], str]] = None,
    ) -> AgentResult:
        """
        Run the agent loop.

        Args:
            user_message: The initial user message.
            tool_executor: Function(tool_name, arguments_dict) -> result_string.
                          Called when the LLM makes tool calls.

        Returns:
            AgentResult with final content and conversation history.
        """
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": user_message},
        ]

        turns = 0
        while turns < self.max_turns:
            turns += 1

            response = self.llm.chat(
                messages=messages,
                model=self.model,
                tools=self.tools,
                temperature=self.temperature,
            )

            # Append assistant message
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if response.content:
                assistant_msg["content"] = response.content
            if response.tool_calls:
                assistant_msg["tool_calls"] = response.tool_calls
            messages.append(assistant_msg)

            # If no tool calls, agent is done
            if not response.tool_calls:
                return AgentResult(
                    content=response.content or "",
                    messages=messages,
                    turns=turns,
                    finish_reason=response.finish_reason,
                )

            # Execute tool calls
            if not tool_executor:
                return AgentResult(
                    content=response.content or "",
                    messages=messages,
                    turns=turns,
                    finish_reason="tool_calls_no_executor",
                )

            for tc in response.tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                arguments_str = func.get("arguments", "{}")
                tool_call_id = tc.get("id", "") or str(uuid.uuid4())

                try:
                    import json
                    arguments = json.loads(arguments_str) if isinstance(arguments_str, str) else arguments_str
                except Exception:
                    arguments = {}

                # Per protocol: openceph_* prefixed tools are shared tools —
                # forward to Brain via IPC instead of executing locally
                if tool_name.startswith("openceph_") and self.ipc:
                    try:
                        ipc_result = self.ipc.tool_request(tool_name, tool_call_id, arguments)
                        if ipc_result.get("success"):
                            import json as _json
                            result = _json.dumps(ipc_result.get("result", {}), ensure_ascii=False)
                        else:
                            result = f"Shared tool error: {ipc_result.get('error', 'unknown')}"
                    except Exception as e:
                        result = f"IPC tool_request error for {tool_name}: {e}"
                else:
                    try:
                        result = tool_executor(tool_name, arguments)
                    except Exception as e:
                        result = f"Error executing tool {tool_name}: {e}"

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": str(result),
                })

        return AgentResult(
            content=messages[-1].get("content", "") if messages else "",
            messages=messages,
            turns=turns,
            finish_reason="max_turns",
        )


class AgentResult:
    """Result of an agent loop run."""

    def __init__(
        self,
        content: str,
        messages: list[dict],
        turns: int,
        finish_reason: str,
    ):
        self.content = content
        self.messages = messages
        self.turns = turns
        self.finish_reason = finish_reason

    def __str__(self) -> str:
        return self.content


def run_agent_loop(
    system_prompt: str,
    user_message: str,
    tools: Optional[list[dict]] = None,
    tool_executor: Optional[Callable[[str, dict], str]] = None,
    max_turns: int = 20,
) -> AgentResult:
    """Convenience function: run a one-shot agent loop."""
    agent = AgentLoop(system_prompt=system_prompt, tools=tools, max_turns=max_turns)
    return agent.run(user_message, tool_executor)
