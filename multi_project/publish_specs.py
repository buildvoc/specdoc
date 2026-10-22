#!/usr/bin/env python3
import json, os, re, subprocess
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote

ROOT=Path(os.environ.get('SPECDOC_ROOT','/data/projects/specdoc')).resolve()

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

def config():
    c=load_env(ROOT/'.env')
    c.update(load_env(os.environ.get('HD2_ENV_FILE') or c.get('HD2_ENV_FILE') or '/data/projects/hedgedoc/.env'))
    c.update(os.environ)
    return c

def slug(s):
    s=re.sub(r'^\d+[_-]+','',s)
    return re.sub(r'[^A-Za-z0-9]+','-',s).strip('-').lower() or 'spec'

def alias_for(p,prefix):
    stem=p.stem.lower()
    return f"{prefix}-{'index' if stem=='index' else 'changelog' if stem=='changelog' else slug(p.stem)}"

def split_frontmatter(text):
    if not text.startswith('---\n'): return {},text
    end=text.find('\n---\n',4)
    if end<0: return {},text
    fields={}
    for line in text[4:end].splitlines():
        if ':' in line and not line[:1].isspace():
            k,v=line.split(':',1); fields[k.strip().lower()]=v.strip()
    return fields,text[end+5:].lstrip('\n')

def title(body,p):
    for line in body.splitlines():
        if line.startswith('# '): return line[2:].strip()
    return p.stem.replace('_',' ').replace('-',' ').title()

def request(method,url,token,body=None,ctype=None):
    headers={'Authorization':f'Bearer {token}'}; data=None
    if body is not None:
        if isinstance(body,str): data=body.encode()
        else: data=json.dumps(body).encode()
        headers['Content-Type']=ctype or 'application/json'
    req=Request(url,data=data,headers=headers,method=method)
    try:
        with urlopen(req,timeout=45) as r: return r.status,r.read()
    except HTTPError as e: return e.code,e.read()

def git(src,*args):
    try: return subprocess.check_output(['git','-C',src,*args],text=True,stderr=subprocess.DEVNULL).strip()
    except Exception: return ''

CRITIC_COMMENT_RE = re.compile(r'\{>>([\s\S]*?)<<\}')

def extract_review_comments(text):
    comments = []
    seen = set()
    for match in CRITIC_COMMENT_RE.finditer(text or ''):
        value = match.group(1).strip()
        if value and value not in seen:
            seen.add(value)
            comments.append(value)
    return comments

def preserve_review_comments(document, existing_content):
    existing = extract_review_comments(existing_content)
    current = set(extract_review_comments(document))
    missing = [comment for comment in existing if comment not in current]
    if not missing:
        return document

    blocks = '\n\n'.join('{>>' + comment + '<<}' for comment in missing)
    return (
        document.rstrip()
        + '\n\n<!-- specdoc-preserved-review-comments -->\n'
        + '## Preserved review comments\n\n'
        + blocks
        + '\n'
    )

def main():
    c=config(); need=['HD_BASE_URL','HD2_TOKEN','SPECDOC_NAMESPACE','SPECDOC_SOURCE','SPECDOC_SPEC_DIR','SPECDOC_ALIAS_PREFIX']
    missing=[k for k in need if not c.get(k)]
    if missing: raise SystemExit('missing configuration: '+', '.join(missing))
    d=Path(c['SPECDOC_SPEC_DIR']).resolve(); paths=sorted(p for p in d.glob('*.md') if p.is_file())
    if not paths: raise SystemExit(f'no markdown specifications in {d}')
    aliases={p.name:alias_for(p,c['SPECDOC_ALIAS_PREFIX']) for p in paths}; base=c['HD_BASE_URL'].rstrip('/'); files=[]
    link_re=re.compile(r'\]\(([^)\s]+\.md)(#[^)]+)?\)')
    for p in paths:
        raw=p.read_text(); old,body=split_frontmatter(raw); a=aliases[p.name]
        def repl(m):
            target=aliases.get(Path(m.group(1)).name)
            return f"]({base}/n/{target}{m.group(2) or ''})" if target else m.group(0)
        body=link_re.sub(repl,body); t=title(body,p)
        kind=old.get('kind','top-level' if p.name=='index.md' else 'feature'); area=old.get('area','generated')
        doc='\n'.join([
            '---',f'title: {json.dumps(t)}','tags: [spec, draft, generated]',f'kind: {kind}',f'area: {area}',
            f'namespace: {json.dumps(c["SPECDOC_NAMESPACE"])}',f'source-path: {json.dumps(c["SPECDOC_SOURCE"])}',
            f'github-repo: {json.dumps(c.get("SPECDOC_PROJECT_GITHUB", ""))}',f'alias: {json.dumps(a)}','generated: true','---',''
        ])+body.rstrip()+'\n'
        url=f"{base}/api/v2/notes/{quote(a,safe='-._~')}"
        status,payload=request('POST',url,c['HD2_TOKEN'],doc,'text/markdown')
        if status == 409:
            get_status, get_payload = request('GET', url, c['HD2_TOKEN'])
            if get_status == 200:
                try:
                    existing = json.loads(get_payload.decode()).get('content', '')
                    doc = preserve_review_comments(doc, existing)
                except Exception as exc:
                    print(f'warning: could not preserve review comments for {a}: {exc}')
            status, payload = request('PUT', url, c['HD2_TOKEN'], doc, 'text/markdown')
        if status not in (200,201,204): raise SystemExit(f'publish failed for {a}: HTTP {status}: {payload.decode(errors="replace")[:300]}')
        vstatus,vpayload=request('PUT',url+'/metadata/permissions/visibility',c['HD2_TOKEN'],{'newPubliclyVisible':True})
        if vstatus not in (200,201,204): raise SystemExit(f'visibility failed for {a}: HTTP {vstatus}: {vpayload.decode(errors="replace")[:300]}')
        print(f'published: {a}')
        files.append({'file':p.name,'alias':a,'title':t,'url':f'{base}/n/{a}'})
    manifest={'version':1,'namespace':c['SPECDOC_NAMESPACE'],'sourcePath':c['SPECDOC_SOURCE'],'githubRepo':c.get('SPECDOC_PROJECT_GITHUB') or None,
              'aliasPrefix':c['SPECDOC_ALIAS_PREFIX'],'generatedAt':datetime.now(timezone.utc).isoformat(),'branch':git(c['SPECDOC_SOURCE'],'branch','--show-current') or None,
              'commit':git(c['SPECDOC_SOURCE'],'rev-parse','HEAD') or None,'files':files}
    tmp=d/'manifest.json.tmp'; tmp.write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n'); tmp.replace(d/'manifest.json')
    print(f'manifest: {d/"manifest.json"}')
if __name__=='__main__': main()
