#!/usr/bin/env python3
"""
SpecDoc approved-@llm artifact worker.

Consumes ONLY human-approved tasks from SpecBoard /api/llm/agent.
It never deploys model changes. It:
  1. plans a small source context with Ollama,
  2. asks Ollama for a unified diff,
  3. validates/applies that diff in a temporary git worktree,
  4. writes .patch, .zip and SHA256SUMS to /backups/builds,
  5. replies to the CriticMarkup thread with one deployment command,
  6. marks the task completed in the shared SpecBoard LLM state.

No third-party Python packages are required.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BOARD_URL = os.environ.get("SPECDOC_LLM_BOARD_URL", "http://127.0.0.1:8080").rstrip("/")
ADAPTER_URL = os.environ.get("SPECDOC_LLM_ADAPTER_URL", "http://127.0.0.1:8081").rstrip("/")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://192.168.1.99:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:26b")
BUILD_DIR = Path(os.environ.get("SPECDOC_LLM_BUILD_DIR", "/backups/builds"))
STATE_FILE = Path(os.environ.get("SPECDOC_LLM_STATE_FILE", "/data/projects/specdoc/llm-review/state.json"))
MAX_TASKS = max(1, int(os.environ.get("SPECDOC_LLM_MAX_TASKS", "1")))
MAX_TREE_CHARS = max(5000, int(os.environ.get("SPECDOC_LLM_MAX_TREE_CHARS", "35000")))
MAX_FILE_CHARS = max(4000, int(os.environ.get("SPECDOC_LLM_MAX_FILE_CHARS", "24000")))
MAX_CONTEXT_CHARS = max(20000, int(os.environ.get("SPECDOC_LLM_MAX_CONTEXT_CHARS", "110000")))
OLLAMA_TIMEOUT = max(60, int(os.environ.get("SPECDOC_LLM_OLLAMA_TIMEOUT", "900")))

SAFE_TEXT_EXTENSIONS = {
    ".md", ".txt", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sh",
    ".bash", ".css", ".scss", ".html", ".xml", ".csv", ".sql", ".go",
    ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".rb",
    ".php", ".vue", ".svelte", ".graphql", ".gql"
}
SAFE_BASENAMES = {
    "README", "README.md", "LICENSE", "Makefile", "Dockerfile", "compose.yaml",
    "docker-compose.yml", "package.json", "pyproject.toml", "requirements.txt",
    "Cargo.toml", "go.mod"
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {shlex.join(cmd)}\n"
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result


def http_json(url: str, method: str = "GET", data: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    body = None
    headers = {"accept": "application/json"}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {url}: HTTP {exc.code}: {payload[:500]}") from exc


def ollama(messages: list[dict[str, str]], json_mode: bool = False) -> str:
    payload: dict[str, Any] = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "messages": messages,
        "options": {"temperature": 0.1},
    }
    if json_mode:
        payload["format"] = "json"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/chat",
        data=data,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=OLLAMA_TIMEOUT) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {payload[:1000]}") from exc
    content = ((result.get("message") or {}).get("content") or "").strip()
    if not content:
        raise RuntimeError("Ollama returned an empty response")
    return content


def git_root(source: Path) -> Path:
    root = run(["git", "-C", str(source), "rev-parse", "--show-toplevel"]).stdout.strip()
    path = Path(root).resolve()
    if not path.is_dir():
        raise RuntimeError(f"invalid git root: {path}")
    return path


def tracked_files(root: Path) -> list[str]:
    raw = run(["git", "-C", str(root), "ls-files", "-z"]).stdout
    return [item for item in raw.split("\0") if item]


def is_safe_context_path(path: str) -> bool:
    p = Path(path)
    if p.is_absolute() or ".." in p.parts:
        return False
    if any(part.startswith(".git") for part in p.parts):
        return False
    return p.name in SAFE_BASENAMES or p.suffix.lower() in SAFE_TEXT_EXTENSIONS


def tree_context(files: list[str]) -> str:
    text = "\n".join(files)
    if len(text) > MAX_TREE_CHARS:
        text = text[:MAX_TREE_CHARS] + "\n... [tree truncated]"
    return text


def parse_json_object(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}


def choose_context_files(task: dict[str, Any], files: list[str]) -> list[str]:
    safe = [path for path in files if is_safe_context_path(path)]
    prompt = f"""You are selecting source files for a coding task.
Return JSON only in this shape:
{{"files":["path1","path2"],"reason":"short reason"}}

Rules:
- Select at most 8 existing tracked text files from the supplied tree.
- Prefer the smallest set sufficient to implement the task.
- Include README.md for documentation-only tasks.
- Do not invent paths.

TASK:
{task.get("instruction","")}

SPECIFICATION:
{str(task.get("specBody",""))[:30000]}

REPOSITORY TREE:
{tree_context(safe)}
"""
    try:
        result = parse_json_object(
            ollama(
                [
                    {"role": "system", "content": "Select a minimal, relevant source context. JSON only."},
                    {"role": "user", "content": prompt},
                ],
                json_mode=True,
            )
        )
        selected = result.get("files") or []
    except Exception as exc:
        print(f"planner warning: {exc}", file=sys.stderr)
        selected = []

    allowed = set(safe)
    output: list[str] = []
    for value in selected:
        path = str(value)
        if path in allowed and path not in output:
            output.append(path)
        if len(output) >= 8:
            break

    if not output:
        for candidate in ("README.md", "README", "package.json", "pyproject.toml"):
            if candidate in allowed:
                output.append(candidate)
                break

    # Add filename-keyword matches if the planner returned too little.
    words = {
        word.lower()
        for word in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", str(task.get("instruction", "")))
        if word.lower() not in {"this", "that", "with", "from", "then", "into", "make", "test", "workflow"}
    }
    if len(output) < 4 and words:
        ranked = sorted(
            (
                (sum(1 for word in words if word in path.lower()), path)
                for path in safe
                if path not in output
            ),
            reverse=True,
        )
        for score, path in ranked:
            if score <= 0 or len(output) >= 4:
                break
            output.append(path)

    return output[:8]


def load_context(root: Path, paths: list[str]) -> str:
    chunks: list[str] = []
    used = 0
    for rel in paths:
        path = root / rel
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:4096]:
            continue
        text = raw.decode("utf-8", "replace")
        if len(text) > MAX_FILE_CHARS:
            text = text[:MAX_FILE_CHARS] + "\n... [file truncated]"
        chunk = f"\n===== FILE: {rel} =====\n{text}\n"
        if used + len(chunk) > MAX_CONTEXT_CHARS:
            break
        chunks.append(chunk)
        used += len(chunk)
    return "".join(chunks)


def extract_patch(text: str) -> str:
    fenced = re.search(r"```(?:diff|patch)?\s*\n([\s\S]*?)```", text, re.IGNORECASE)
    if fenced:
        text = fenced.group(1)
    start_positions = [pos for pos in (text.find("diff --git "), text.find("--- a/")) if pos >= 0]
    if start_positions:
        text = text[min(start_positions):]
    text = text.strip()
    if "diff --git " not in text and not (text.startswith("--- ") and "\n+++ " in text):
        raise RuntimeError("model did not return a unified diff")
    return text + "\n"


def request_patch(task: dict[str, Any], root: Path, selected: list[str], context: str) -> str:
    branch = run(["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    head = run(["git", "-C", str(root), "rev-parse", "HEAD"]).stdout.strip()

    prompt = f"""Create the implementation for this HUMAN-APPROVED SpecDoc task.

Task ID: {task.get("id")}
Task type: {task.get("action")}
GitHub work item: {task.get("githubUrl")}
Repository: {task.get("repo")}
Branch: {branch}
HEAD: {head}

TASK:
{task.get("instruction","")}

SPECIFICATION:
{str(task.get("specBody",""))[:40000]}

SELECTED SOURCE CONTEXT:
{context}

REQUIREMENTS:
- Return ONLY a valid unified git diff.
- Make the smallest change that satisfies the approved task.
- Do not change secrets, credentials, .env files, generated build output, dependency lockfiles unless directly required, or anything outside the repository.
- Do not add deployment side effects.
- Do not commit, push, open PRs, close issues, or claim deployment.
- The diff must apply cleanly to the supplied files at HEAD.
"""
    response = ollama(
        [
            {
                "role": "system",
                "content": "You are a careful coding agent. Produce only an applyable unified git diff; no prose.",
            },
            {"role": "user", "content": prompt},
        ]
    )
    return extract_patch(response)


def repair_patch(task: dict[str, Any], patch: str, error: str, context: str) -> str:
    prompt = f"""Repair this unified diff so `git apply --check` succeeds.

TASK:
{task.get("instruction","")}

GIT APPLY ERROR:
{error}

SOURCE CONTEXT:
{context}

BAD DIFF:
{patch}

Return ONLY the corrected unified git diff. Do not add prose.
"""
    return extract_patch(
        ollama(
            [
                {"role": "system", "content": "Repair the patch only. Output unified diff only."},
                {"role": "user", "content": prompt},
            ]
        )
    )


def validate_and_materialize(task: dict[str, Any], root: Path, patch: str, context: str) -> tuple[str, list[str]]:
    worktree_parent = Path(tempfile.mkdtemp(prefix="specdoc-llm-worktree-"))
    worktree = worktree_parent / "repo"
    try:
        run(["git", "-C", str(root), "worktree", "add", "--detach", str(worktree), "HEAD"])
        patch_file = worktree_parent / "candidate.patch"
        patch_file.write_text(patch, encoding="utf-8")

        checked = run(["git", "apply", "--check", str(patch_file)], cwd=worktree, check=False)
        if checked.returncode != 0:
            error = checked.stderr.strip() or checked.stdout.strip()
            patch = repair_patch(task, patch, error, context)
            patch_file.write_text(patch, encoding="utf-8")
            run(["git", "apply", "--check", str(patch_file)], cwd=worktree)

        run(["git", "apply", str(patch_file)], cwd=worktree)
        run(["git", "add", "-N", "."], cwd=worktree)
        final_patch = run(["git", "diff", "--binary", "HEAD"], cwd=worktree).stdout
        if not final_patch.strip():
            raise RuntimeError("validated task produced no source changes")

        names = run(["git", "diff", "--name-only", "HEAD"], cwd=worktree).stdout.splitlines()
        changed = [name.strip() for name in names if name.strip()]
        return final_patch, changed
    finally:
        run(["git", "-C", str(root), "worktree", "remove", "--force", str(worktree)], check=False)
        shutil.rmtree(worktree_parent, ignore_errors=True)


def safe_slug(value: str, limit: int = 44) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return (slug or "task")[:limit].rstrip("-")


def package_artifacts(task: dict[str, Any], root: Path, patch: str, changed: list[str]) -> dict[str, str]:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"llm-task-{safe_slug(str(task.get('id','task')), 20)}-{stamp}"
    patch_path = BUILD_DIR / f"{base}.patch"
    zip_path = BUILD_DIR / f"{base}.zip"
    sums_path = BUILD_DIR / f"{base}-SHA256SUMS"

    patch_path.write_text(patch, encoding="utf-8")

    manifest = {
        "taskId": task.get("id"),
        "action": task.get("action"),
        "instruction": task.get("instruction"),
        "githubUrl": task.get("githubUrl"),
        "specId": task.get("specId"),
        "specTitle": task.get("specTitle"),
        "namespace": task.get("namespace"),
        "repo": task.get("repo"),
        "sourcePath": str(root),
        "generatedAt": now_iso(),
        "model": OLLAMA_MODEL,
        "changedFiles": changed,
        "humanApproved": True,
        "autoDeployed": False,
    }

    deploy = f"""#!/usr/bin/env bash
set -euo pipefail
ROOT={shlex.quote(str(root))}
HERE="$(cd "$(dirname "${{BASH_SOURCE[0]}}")" && pwd)"
PATCH="$HERE/{patch_path.name}"
cd "$ROOT"
git apply --check "$PATCH"
git apply "$PATCH"
echo "Applied approved @llm patch: {patch_path.name}"
echo "No commit or push was performed."
"""

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        archive.writestr(patch_path.name, patch)
        info = zipfile.ZipInfo("deploy.sh")
        info.external_attr = 0o755 << 16
        archive.writestr(info, deploy)

    patch_hash = hashlib.sha256(patch_path.read_bytes()).hexdigest()
    zip_hash = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    sums_path.write_text(
        f"{patch_hash}  {patch_path.name}\n{zip_hash}  {zip_path.name}\n",
        encoding="utf-8",
    )

    return {
        "base": base,
        "patch": str(patch_path),
        "zip": str(zip_path),
        "sums": str(sums_path),
        "deploy": (
            f"cd /backups/builds && rm -rf {base} && mkdir -p {base} && "
            f"unzip -q {zip_path.name} -d {base} && ./{base}/deploy.sh"
        ),
    }


def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def locate_task_comment(spec_body: str, instruction: str) -> str | None:
    needle = normalized(instruction)
    probe = needle[:100]
    candidates: list[str] = []
    for match in re.finditer(r"\{>>([\s\S]*?)<<\}", spec_body):
        raw = match.group(0)
        inner = match.group(1)
        if re.search(r"(?:^|\s)@llm\b", inner, re.IGNORECASE):
            candidates.append(raw)
            if probe and probe in normalized(inner):
                return raw
    return candidates[0] if len(candidates) == 1 else None


def critic_safe(value: str) -> str:
    return value.replace("{>>", "{ >>").replace("<<}", "<< }")


def reply_to_thread(task: dict[str, Any], artifacts: dict[str, str]) -> None:
    spec_body = str(task.get("specBody") or "")
    original = locate_task_comment(spec_body, str(task.get("instruction") or ""))
    if not original:
        raise RuntimeError("unable to locate the originating @llm CriticMarkup comment")

    result = (
        f"@worker: Completed artifact generation for approved task {task.get('id')}. "
        f"GitHub: {task.get('githubUrl') or 'n/a'}. "
        f"Patch: {artifacts['patch']}. ZIP: {artifacts['zip']}. "
        f"SHA256SUMS: {artifacts['sums']}. "
        f"Human deployment only: `{artifacts['deploy']}`"
    )
    reply = "{>>" + critic_safe(result) + "<<}"
    new_text = original + reply

    spec_id = urllib.parse.quote(str(task["specId"]), safe="")
    http_json(
        f"{ADAPTER_URL}/api/specs/{spec_id}/update",
        method="POST",
        data={"old_text": original, "new_text": new_text},
        timeout=30,
    )


def load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid LLM state JSON: {STATE_FILE}: {exc}") from exc


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_name(f"{STATE_FILE.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def mark_attempt(task_id: str, **values: Any) -> None:
    state = load_state()
    record = dict(state.get(task_id) or {})
    record.update(values)
    state[task_id] = record
    save_state(state)


def process_task(task: dict[str, Any]) -> None:
    task_id = str(task.get("id") or "")
    if not task_id:
        raise RuntimeError("approved task has no id")
    if not task.get("humanApproved"):
        raise RuntimeError(f"refusing unapproved task {task_id}")

    source = Path(str(task.get("sourcePath") or "")).resolve()
    root = git_root(source)

    state = load_state()
    record = dict(state.get(task_id) or {})
    if record.get("status") == "completed":
        print(f"{task_id}: already completed")
        return

    attempts = int(record.get("workerAttempts") or 0) + 1
    mark_attempt(task_id, workerAttempts=attempts, workerStartedAt=now_iso(), workerStatus="running")

    files = tracked_files(root)
    selected = choose_context_files(task, files)
    if not selected:
        raise RuntimeError("unable to select any source context files")

    print(f"{task_id}: context files: {', '.join(selected)}")
    context = load_context(root, selected)
    patch = request_patch(task, root, selected, context)
    final_patch, changed = validate_and_materialize(task, root, patch, context)
    artifacts = package_artifacts(task, root, final_patch, changed)

    # Reply before marking completed. If this fails the task remains approved and can retry.
    reply_to_thread(task, artifacts)

    state = load_state()
    record = dict(state.get(task_id) or {})
    record.update(
        {
            "status": "completed",
            "workerStatus": "completed",
            "completedAt": now_iso(),
            "artifacts": artifacts,
            "changedFiles": changed,
            "model": OLLAMA_MODEL,
        }
    )
    state[task_id] = record
    save_state(state)

    print(f"{task_id}: completed")
    print(f"patch: {artifacts['patch']}")
    print(f"zip: {artifacts['zip']}")
    print(f"sums: {artifacts['sums']}")


def main() -> int:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    feed = http_json(f"{BOARD_URL}/api/llm/agent", timeout=60)
    tasks = list((feed or {}).get("tasks") or [])
    if not tasks:
        print("No approved @llm tasks.")
        return 0

    processed = 0
    failures = 0
    for task in tasks:
        if processed >= MAX_TASKS:
            break
        task_id = str(task.get("id") or "unknown")
        try:
            process_task(task)
            processed += 1
        except Exception as exc:
            failures += 1
            print(f"{task_id}: ERROR: {exc}", file=sys.stderr)
            try:
                state = load_state()
                record = dict(state.get(task_id) or {})
                attempts = int(record.get("workerAttempts") or 0)
                record.update(
                    {
                        "workerStatus": "failed",
                        "workerLastError": str(exc)[:2000],
                        "workerFailedAt": now_iso(),
                        "workerAttempts": attempts,
                    }
                )
                # Preserve human-approved state so a later timer run can retry.
                if record.get("status") != "completed":
                    record["status"] = "approved"
                state[task_id] = record
                save_state(state)
            except Exception as state_exc:
                print(f"{task_id}: state update failed: {state_exc}", file=sys.stderr)

    return 1 if failures and not processed else 0


if __name__ == "__main__":
    raise SystemExit(main())
