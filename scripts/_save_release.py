import json, sys, urllib.request
req = urllib.request.Request(
    "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.2-rc.1",
    headers={"User-Agent": "dsh-compat-check"})
with urllib.request.urlopen(req, timeout=30) as r:
    j = json.load(r)
b = j.get("body", "")
with open(r"E:\dsh-update-022rc1-check\release-body.md", "w", encoding="utf-8", errors="replace") as f:
    f.write(b)
print("saved", len(b))
