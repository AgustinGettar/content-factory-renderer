"""Scoped security regression: no protected runtime mutations or secrets in this delta.
Not a substitute for a repository-wide security audit. Does not contact providers.
"""
import pathlib, re, subprocess

BASE = 'f42d5a83e2806b3db17080c2829d305bad4a8525'
paths = subprocess.check_output(['git', 'diff', '--name-only', BASE, 'HEAD'], text=True).splitlines()
allowed_prefixes = ('lib/cinematic-director-v1/', 'docs/cinematic-director-v1/', 'test/fixtures/director-')
allowed = {'lib/lumi-series-v2-execution.js', '.github/workflows/lumi-cinematic-director-v1.yml'}
for path in paths:
    assert path in allowed or path.startswith(allowed_prefixes) or re.fullmatch(r'(scripts/director-[\w.-]+|test/lumi-cinematic-director[\w.-]+)', path), 'Protected surface changed: ' + path
    content = pathlib.Path(path).read_text() if pathlib.Path(path).exists() else ''
    assert not re.search(r'eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}', content), 'JWT detected: ' + path
    assert not re.search(r'(?i)(?:[?&](?:token|signature|x-amz-signature)=)[a-zA-Z0-9_%.-]{12,}', content), 'Signed URL detected: ' + path
    assert not re.search(r'(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{15,}', content), 'Secret detected: ' + path
runtime = 'lib/lumi-series-v2-execution.js'
before = subprocess.check_output(['git', 'show', BASE + ':' + runtime], text=True)
after = pathlib.Path(runtime).read_text()
after = after.replace(',directorReview}={})', '}={})')
block = """ if(env.LUMI_CINEMATIC_DIRECTOR_V1==='true'){
  const {reviewAtCanonicalBoundary}=await import('./cinematic-director-v1/integration.js');
  return reviewAtCanonicalBoundary({env,directorReview});
 }
"""
after = after.replace(block, '')
assert after == before, 'Legacy runtime changed outside the opt-in boundary'
print('SECURITY_DIFF=PASS; protected surfaces unchanged; credential scan PASS')
