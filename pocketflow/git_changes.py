#!/usr/bin/env python3

import subprocess
import sys
from pathlib import Path

from utils.call_llm import call_llm


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    ).stdout.strip()


source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()

if not (source / ".git").exists():
    print(f"No .git repository at {source}; skipping change log.")
    raise SystemExit(0)

branch = git(source, "branch", "--show-current") or "detached"
base = "master"

if subprocess.run(
    ["git", "-C", str(source), "rev-parse", "--verify", "--quiet", base],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
).returncode != 0:
    roots = git(source, "rev-list", "--max-parents=0", "HEAD").splitlines()
    base = roots[0] if roots else "HEAD"

merge_base = git(source, "merge-base", base, "HEAD") or base
commits = git(source, "log", "--date=short", "--pretty=format:%h | %ad | %an | %s", f"{merge_base}..HEAD")
name_status = git(source, "diff", "--name-status", f"{merge_base}..HEAD")
diff_stat = git(source, "diff", "--stat", f"{merge_base}..HEAD")
working_status = git(source, "status", "--short")
working_stat = git(source, "diff", "--stat")

prompt = f"""
Write a precise engineering change log for the repository `{source.name}`.

Current branch: {branch}
Base branch/reference: {base}
Merge base: {merge_base}

COMMITTED CHANGES:
{commits or "(none)"}

FILES CHANGED BETWEEN BASE AND CURRENT BRANCH:
{name_status or "(none)"}

DIFF STATISTICS:
{diff_stat or "(none)"}

CURRENT UNCOMMITTED WORKING TREE:
{working_status or "(clean)"}

UNCOMMITTED DIFF STATISTICS:
{working_stat or "(none)"}

Requirements:
- Output Markdown only.
- Title must be: # Change Log
- Explain the purpose and effect of the changes, not just filenames.
- Separate committed branch changes from current uncommitted changes.
- Include the branch relationship `{base} → {branch}`.
- Group related changes by subsystem where possible.
- Mention added, changed, removed, or migrated functionality.
- Do not invent changes not supported by the Git information.
- Do not include tutorial language.
- End with a section named "## Repository State".
"""

content = call_llm(prompt, use_cache=False).strip()
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(content + "\n", encoding="utf-8")
print(f"Wrote {output}")
