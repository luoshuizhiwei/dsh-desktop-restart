"""Scan old/new app.asar binaries for the exact strings the restart plugin depends on."""
import sys

OLD = r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"
NEW = r"E:\dsh-update-022rc1-check\new\app.asar"

NEEDLES = [
    # client slots the plugin registers into
    b"sidebar.footer.action",
    b"sidebar.panellist",
    b"dsh-client-ui-primitives",
    b"dsh-client-ui-conversation",
    b"dsh-client-ui-settings",
    b"dsh-client-locale",
    b"dsh.client",
    b"platform",
    # account-menu hider
    b"\xe6\x84\x8f\xe8\xa7\x81\xe5\x8f\x8d\xe9\xa6\x88",  # 意见反馈
    b"Feedback",
    b"menuitem",
    b'[role="menu"]',
    # host-side service contracts
    b"webServer",
    b"requestRejection",
    b"commands",
    b"register",
    b"kind",
    b"exact",
    b"quit-inspection",
    b"shutdown-complete",
    b"platform-session",
    b"update-tasks",
    b"ready",
    b"fatal",
    # desktop host internals (restart mechanism)
    b"ELECTRON_RUN_AS_NODE",
    b"treeAlive",
    b"plugin-manager",
    b"run.json",
    b"dsh-workspace-changes",
]

def count(path, needle):
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            n += chunk.count(needle)
    return n

for label, path in (("OLD 0.2.1-rc.5", OLD), ("NEW 0.2.2-rc.1", NEW)):
    print("=" * 70)
    print(label, path)
    print("=" * 70)
    for s in NEEDLES:
        c = count(path, s)
        try:
            name = s.decode("utf-8")
        except Exception:
            name = repr(s)
        flag = "  <-- GONE" if c == 0 else ""
        print("  %-40s %8d%s" % (name[:40], c, flag))
