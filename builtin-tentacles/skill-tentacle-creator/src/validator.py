from pathlib import Path
import py_compile


def validate_skill_tentacle(target: Path) -> list[str]:
    required = [
        target / "SKILL.md",
        target / "README.md",
        target / "prompt" / "SYSTEM.md",
        target / "src" / "main.py",
        target / "src" / "ipc_client.py",
    ]
    errors = [f"missing: {item.relative_to(target)}" for item in required if not item.exists()]
    if errors:
        return errors

    try:
        py_compile.compile(str(target / "src" / "main.py"), doraise=True)
    except py_compile.PyCompileError as exc:
        errors.append(f"syntax error in src/main.py: {exc.msg}")
    return errors
