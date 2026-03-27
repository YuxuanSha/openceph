"""
hn-radar 配置模块
从环境变量加载所有配置，提供默认值。
"""

import os
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class HNRadarConfig:
    # ─── openceph 标准变量 ───
    tentacle_id: str = ""
    llm_gateway_url: str = ""
    llm_gateway_token: str = ""
    tentacle_workspace: str = ""
    tentacle_dir: str = ""
    trigger_mode: str = "self"

    # ─── Jina API ───
    jina_api_key: str = ""

    # ─── 用户可定制 ───
    interests: list[str] = field(default_factory=lambda: [
        "AI Agent", "LLM", "autonomous systems", "developer tools", "startup"
    ])
    anti_interests: list[str] = field(default_factory=lambda: [
        "cryptocurrency", "blockchain", "NFT", "Web3"
    ])
    report_language: str = "中文"
    min_score: int = 10
    poll_interval: int = 1800  # 30 分钟
    batch_threshold: int = 3
    max_silent_hours: int = 12

    # ─── 内部常量 ───
    rss_url: str = "https://hnrss.org/newest?points=5"
    algolia_url: str = "https://hn.algolia.com/api/v1/search_by_date"
    jina_search_url: str = "https://s.jina.ai/"
    jina_reader_url: str = "https://r.jina.ai/"
    agent_max_turns: int = 30
    quick_judge_batch_size: int = 10  # 每批发给 LLM 判断的数量

    @classmethod
    def from_env(cls) -> "HNRadarConfig":
        def split_list(val: str) -> list[str]:
            return [s.strip() for s in val.split(",") if s.strip()]

        return cls(
            tentacle_id=os.environ.get("OPENCEPH_TENTACLE_ID", "t_hn_radar"),
            llm_gateway_url=os.environ.get("OPENCEPH_LLM_GATEWAY_URL", "http://127.0.0.1:18792"),
            llm_gateway_token=os.environ.get("OPENCEPH_LLM_GATEWAY_TOKEN", ""),
            tentacle_workspace=os.environ.get("OPENCEPH_TENTACLE_WORKSPACE", ""),
            tentacle_dir=os.environ.get("OPENCEPH_TENTACLE_DIR", str(Path(__file__).parent.parent)),
            trigger_mode=os.environ.get("OPENCEPH_TRIGGER_MODE", "self"),
            jina_api_key=os.environ.get("JINA_API_KEY", ""),
            interests=split_list(os.environ.get(
                "HN_INTERESTS",
                "AI Agent, LLM, autonomous systems, developer tools, startup"
            )),
            anti_interests=split_list(os.environ.get(
                "HN_ANTI_INTERESTS",
                "cryptocurrency, blockchain, NFT, Web3"
            )),
            report_language=os.environ.get("HN_REPORT_LANGUAGE", "中文"),
            min_score=int(os.environ.get("HN_MIN_SCORE", "10")),
            poll_interval=int(os.environ.get("HN_POLL_INTERVAL", "1800")),
            batch_threshold=int(os.environ.get("HN_BATCH_THRESHOLD", "3")),
            max_silent_hours=int(os.environ.get("HN_MAX_SILENT_HOURS", "12")),
        )

    @property
    def workspace_path(self) -> Path:
        if self.tentacle_workspace:
            return Path(self.tentacle_workspace)
        return Path(self.tentacle_dir) / "workspace"

    @property
    def data_path(self) -> Path:
        return Path(self.tentacle_dir) / "data"

    @property
    def logs_path(self) -> Path:
        return Path(self.tentacle_dir) / "logs"

    @property
    def reports_path(self) -> Path:
        return Path(self.tentacle_dir) / "reports"