#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
from urllib.request import Request, urlopen
from datetime import datetime, timezone

def load_env(path):
    out={}
    try:
        for raw in Path(path).read_text().splitlines():
            line=raw.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k,v=line.split('=',1); v=v.strip()
            if len(v)>=2 and v[0]==v[-1] and v[0] in "'\"": v=v[1:-1]
            out[k.strip()]=v
    except FileNotFoundError: pass
    return out

def git(src,*args):
    try: return subprocess.check_output(['git','-C',src,*args],text=True,stderr=subprocess.STDOUT).strip()
    except subprocess.CalledProcessError as e: return e.output.strip()

def main():
    if len(sys.argv)!=3: raise SystemExit('usage: project_changelog.py SOURCE OUTPUT')
    src=str(Path(sys.argv[1]).resolve()); out=Path(sys.argv[2]).resolve(); out.parent.mkdir(parents=True,exist_ok=True)
    env=load_env(Path(__file__).resolve().parent/'.env'); env.update(os.environ)
    branch=git(src,'branch','--show-current'); commit=git(src,'rev-parse','HEAD'); log=git(src,'log','-20','--date=short','--pretty=format:%h %ad %s'); status=git(src,'status','--short')
    prompt=f"""Create a concise technical CHANGELOG in Markdown for this repository. Describe the purpose of recent changes, do not invent changes, and begin exactly with '# Change Log'.\n\nRepository: {src}\nBranch: {branch}\nCommit: {commit}\n\nRecent commits:\n{log}\n\nWorking tree:\n{status or '(clean)'}\n"""
    try:
        req=Request(env.get('OLLAMA_BASE_URL','http://127.0.0.1:11434').rstrip('/')+'/api/generate',data=json.dumps({'model':env.get('OLLAMA_MODEL','gemma4:26b'),'prompt':prompt,'stream':False}).encode(),headers={'Content-Type':'application/json'},method='POST')
        with urlopen(req,timeout=600) as r: text=(json.loads(r.read().decode()).get('response') or '').strip()
        if not text.startswith('# Change Log'): raise ValueError('invalid model output')
    except Exception as e:
        print(f'changelog model unavailable; using git fallback: {e}',file=sys.stderr)
        text=f"# Change Log\n\nGenerated {datetime.now(timezone.utc).isoformat()}\n\n## Repository state\n\n- Branch: `{branch or 'unknown'}`\n- Commit: `{commit or 'unknown'}`\n\n## Recent commits\n\n```text\n{log or '(none)'}\n```\n\n## Working tree\n\n```text\n{status or '(clean)'}\n```\n"
    out.write_text(text.rstrip()+'\n')
if __name__=='__main__': main()
