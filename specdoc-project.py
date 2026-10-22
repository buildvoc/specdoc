#!/usr/bin/env python3
import argparse, json, os, re, shlex, subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(os.environ.get('SPECDOC_ROOT', '/data/projects/specdoc')).resolve()
PROJECTS = Path('/data/projects').resolve()

def git(src, *args):
    try:
        return subprocess.check_output(['git','-C',str(src),*args], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ''

def slug(s):
    return re.sub(r'[^A-Za-z0-9._-]+','-',s).strip('-_.').lower() or 'project'

def from_remote(remote):
    if not remote: return None
    for pat in (r'github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?$', r'^https?://[^/]+/([^/]+)/([^/]+?)(?:\.git)?$', r'^[^@]+@[^:]+:([^/]+)/([^/]+?)(?:\.git)?$'):
        m = re.search(pat, remote)
        if m: return f"{m.group(1)}/{m.group(2).removesuffix('.git')}"
    return None

def resolve(source):
    source = Path(source).expanduser().resolve()
    try: source.relative_to(PROJECTS)
    except ValueError: raise SystemExit(f'source must be under {PROJECTS}: {source}')
    if not source.is_dir(): raise SystemExit(f'source does not exist: {source}')
    origin = git(source,'remote','get-url','origin')
    upstream = git(source,'remote','get-url','upstream')
    ns = os.environ.get('SPECDOC_PROJECT_NAMESPACE','').strip() or from_remote(origin) or from_remote(upstream) or f'local/{slug(source.name)}'
    if '/' not in ns: raise SystemExit('namespace must be owner/repo')
    owner, repo = ns.split('/',1)
    owner_s, repo_s = slug(owner), slug(repo)
    prefix = os.environ.get('SPECDOC_PROJECT_ALIAS_PREFIX','').strip() or ('specdoc' if ns == 'buildvoc/specdoc' else f'{owner_s}-{repo_s}')
    remote = origin or upstream
    return {
        'source': str(source), 'namespace': ns, 'owner': owner, 'repo': repo,
        'projectName': repo, 'projectKey': f'{owner_s}__{repo_s}', 'aliasPrefix': slug(prefix),
        'outputDir': str(ROOT/'specifications'/owner_s/repo_s),
        'registryFile': str(ROOT/'projects'/'registry.json'),
        'githubRepo': ns if 'github.com' in remote else '', 'remote': remote,
        'branch': git(source,'branch','--show-current'), 'commit': git(source,'rev-parse','HEAD')
    }

def shell(i):
    mapping = {
        'SPECDOC_SOURCE':'source','SPECDOC_NAMESPACE':'namespace','SPECDOC_PROJECT_OWNER':'owner','SPECDOC_PROJECT_REPO':'repo',
        'SPECDOC_PROJECT_NAME':'projectName','SPECDOC_PROJECT_KEY':'projectKey','SPECDOC_ALIAS_PREFIX':'aliasPrefix','SPECDOC_SPEC_DIR':'outputDir',
        'SPECDOC_PROJECT_REGISTRY':'registryFile','SPECDOC_PROJECT_GITHUB':'githubRepo','SPECDOC_PROJECT_REMOTE':'remote','SPECDOC_PROJECT_BRANCH':'branch','SPECDOC_PROJECT_COMMIT':'commit'
    }
    for env,key in mapping.items():
        print(f"{env}={shlex.quote(str(i.get(key,'')))}")
        print(f'export {env}')

def registry(i):
    p = Path(i['registryFile']); p.parent.mkdir(parents=True, exist_ok=True)
    try: data = json.loads(p.read_text()) if p.exists() else {}
    except Exception: data = {}
    projects = data.setdefault('projects',{})
    projects[i['namespace']] = {
        'namespace':i['namespace'],'sourcePath':i['source'],'outputDir':i['outputDir'],'aliasPrefix':i['aliasPrefix'],
        'githubRepo':i['githubRepo'] or None,'remote':i['remote'] or None,'branch':i['branch'] or None,'commit':i['commit'] or None,
        'lastRefresh':datetime.now(timezone.utc).isoformat()
    }
    data['version']=1
    tmp=p.with_suffix('.tmp'); tmp.write_text(json.dumps(data,indent=2,sort_keys=True)+'\n'); tmp.replace(p)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--source',required=True); ap.add_argument('--format',choices=('json','shell'),default='json'); ap.add_argument('--write-registry',action='store_true')
    a=ap.parse_args(); i=resolve(a.source)
    if a.write_registry: registry(i)
    shell(i) if a.format=='shell' else print(json.dumps(i,indent=2,sort_keys=True))
if __name__=='__main__': main()
