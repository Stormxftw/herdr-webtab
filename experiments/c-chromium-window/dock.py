"""Experiment C: dock a real headed Chromium window *inside* Herdr's window.

Launches Chromium in --app mode (no browser chrome) with its own CDP port so
agents can drive it, strips its frame, SetParent()s it into the Herdr HWND and
keeps it positioned over the webtab view using the bounds the mod publishes.

usage: python dock.py [url]
"""
import ctypes, ctypes.wintypes as W, json, os, subprocess, sys, time

user32 = ctypes.WinDLL("user32", use_last_error=True)
CHROME = os.environ.get("WEBTAB_CHROME", "chrome.exe")  # a Chromium build
PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chromium-docked")
BOUNDS = os.path.expandvars(r"%USERPROFILE%\.config\herdr-app\data\webtab\bounds.json")
URL = sys.argv[1] if len(sys.argv) > 1 else "https://news.ycombinator.com"

GWL_STYLE, WS_CHILD, WS_VISIBLE, WS_POPUP = -16, 0x40000000, 0x10000000, 0x80000000
WS_CAPTION, WS_THICKFRAME = 0x00C00000, 0x00040000
SWP_SHOWWINDOW, SWP_FRAMECHANGED, SWP_NOZORDER = 0x40, 0x20, 0x4
EnumWindowsProc = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.SetWindowLongPtrW.argtypes = [W.HWND, ctypes.c_int, ctypes.c_ssize_t]


def windows():
    out = []
    def cb(h, _):
        pid = W.DWORD(); user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        n = user32.GetWindowTextLengthW(h); buf = ctypes.create_unicode_buffer(n + 1); user32.GetWindowTextW(h, buf, n + 1)
        cls = ctypes.create_unicode_buffer(256); user32.GetClassNameW(h, cls, 256)
        out.append((h, pid.value, buf.value, cls.value, bool(user32.IsWindowVisible(h))))
        return True
    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def herdr_hwnd():
    import subprocess as sp
    pids = sp.run(["powershell", "-NoProfile", "-Command", "(Get-Process herdr-app).Id"], capture_output=True, text=True).stdout.split()
    pids = {int(p) for p in pids}
    for h, pid, title, cls, vis in windows():
        if pid in pids and vis and title == "Herdr":
            return h
    raise SystemExit("Herdr window not found")


def scale_for(hwnd):
    try: return user32.GetDpiForWindow(hwnd) / 96.0
    except Exception: return 1.0


def main():
    host = herdr_hwnd(); dpi = scale_for(host)
    print("herdr hwnd", hex(host), "dpi scale", dpi)
    before = {w[0] for w in windows()}
    proc = subprocess.Popen([CHROME, f"--app={URL}", "--remote-debugging-port=9334", "--remote-debugging-address=127.0.0.1",
                             "--remote-allow-origins=*", f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
                             "--disable-sync", "--window-size=900,700"])
    child = None
    for _ in range(100):
        time.sleep(0.1)
        for h, pid, title, cls, vis in windows():
            if h not in before and vis and cls.startswith("Chrome_WidgetWin"):
                child = h; break
        if child: break
    if not child: raise SystemExit("chromium window not found")
    print("chromium hwnd", hex(child))
    style = user32.GetWindowLongPtrW(child, GWL_STYLE)
    style = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD | WS_VISIBLE
    user32.SetWindowLongPtrW(child, GWL_STYLE, style)
    user32.SetParent(child, host)
    last = None
    while proc.poll() is None:
        try:
            b = json.load(open(BOUNDS))
            rect = tuple(round(v * dpi) for v in (b["x"], b["y"], b["width"], b["height"]))
        except Exception:
            rect = (316, 127, 949, 1207)
        if rect != last:
            user32.SetWindowPos(child, 0, *rect, SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOZORDER)
            print("placed", rect, flush=True); last = rect
        time.sleep(0.25)


if __name__ == "__main__":
    main()
