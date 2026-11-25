"""Experiment C v2: a real headed Chromium as an *owned popup* over the Herdr webtab.

v1 (dock.py) made Chromium a WS_CHILD of Herdr's window. Herdr repaints its whole
DirectX surface every frame, so the child flashed. Here Chromium stays a separate
top-level window, owned by Herdr (always above it, minimizes with it, no taskbar
button), and DWM composites the two independently. It is placed in screen
coordinates over the rectangle the webtab mod publishes, and hidden whenever the
mod reports its tab isn't showing. Never activated programmatically.

usage: python dock2.py [url]
"""
import ctypes, ctypes.wintypes as W, json, os, subprocess, sys, time

user32 = ctypes.WinDLL("user32", use_last_error=True)
CHROME = os.environ.get("WEBTAB_CHROME", "chrome.exe")  # a Chromium build
PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chromium-docked")
BOUNDS = os.path.expandvars(r"%USERPROFILE%\.config\herdr-app\data\webtab\bounds.json")
URL = sys.argv[1] if len(sys.argv) > 1 else "https://news.ycombinator.com"
# Chromium draws its own title bar + "Chrome for Testing" banner inside the window. Measured via CDP:
# outerHeight - innerHeight = 93, outerWidth - innerWidth = 14. Oversize the window and clip with a region.
SIDE, TOP, BOTTOM = int(os.environ.get("DOCK_SIDE", 7)), int(os.environ.get("DOCK_TOP", 86)), int(os.environ.get("DOCK_BOTTOM", 7))
gdi32 = ctypes.WinDLL("gdi32")

GWL_STYLE, GWL_EXSTYLE, GWLP_HWNDPARENT = -16, -20, -8
WS_POPUP, WS_VISIBLE, WS_CAPTION, WS_THICKFRAME, WS_CHILD = 0x80000000, 0x10000000, 0x00C00000, 0x00040000, 0x40000000
WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX = 0x00080000, 0x00020000, 0x00010000
WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = 0x80, 0x40000
SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_HIDEWINDOW, SWP_FRAMECHANGED, SWP_NOZORDER, SWP_NOOWNERZORDER = 0x10, 0x40, 0x80, 0x20, 0x4, 0x200
SW_SHOWMINNOACTIVE, SW_HIDE = 7, 0
EnumWindowsProc = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetWindowLongPtrW.argtypes = [W.HWND, ctypes.c_int]
user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
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
    pids = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process herdr-app).Id"], capture_output=True, text=True).stdout.split()
    pids = {int(p) for p in pids}
    for h, pid, title, cls, vis in windows():
        if pid in pids and title == "Herdr":
            return h
    raise SystemExit("Herdr window not found")


def main():
    host = herdr_hwnd()
    before = {w[0] for w in windows()}
    si = subprocess.STARTUPINFO(); si.dwFlags |= subprocess.STARTF_USESHOWWINDOW; si.wShowWindow = SW_SHOWMINNOACTIVE
    proc = subprocess.Popen([CHROME, f"--app={URL}", "--remote-debugging-port=9334", "--remote-debugging-address=127.0.0.1",
                             "--remote-allow-origins=*", f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
                             "--disable-sync", "--disable-direct-composition", "--window-position=-32000,-32000", "--window-size=900,700"], startupinfo=si)
    win = None
    for _ in range(150):
        time.sleep(0.1)
        for h, pid, title, cls, vis in windows():
            if h not in before and cls.startswith("Chrome_WidgetWin") and (vis or title):
                win = h; break
        if win: break
    if not win: raise SystemExit("chromium window not found")
    # Frameless popup, owned by Herdr, no taskbar button.
    style = user32.GetWindowLongPtrW(win, GWL_STYLE)
    style = (style & ~(WS_CAPTION | WS_THICKFRAME | WS_CHILD | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_POPUP
    user32.SetWindowLongPtrW(win, GWL_STYLE, style)
    ex = user32.GetWindowLongPtrW(win, GWL_EXSTYLE)
    user32.SetWindowLongPtrW(win, GWL_EXSTYLE, (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW)
    user32.SetWindowLongPtrW(win, GWLP_HWNDPARENT, host)  # owner, not parent
    user32.ShowWindow(win, 4)  # SW_SHOWNOACTIVATE (restores from minimized without focus)
    print("herdr", hex(host), "chromium", hex(win), flush=True)

    dpi = user32.GetDpiForWindow(host) / 96.0
    last = None
    while proc.poll() is None and user32.IsWindow(host):
        try:
            b = json.load(open(BOUNDS))
        except Exception:
            time.sleep(0.1); continue
        pt = W.POINT(0, 0); user32.ClientToScreen(host, ctypes.byref(pt))
        shown = b.get("shown", True) and not user32.IsIconic(host)
        rect = (pt.x + round(b["x"] * dpi), pt.y + round(b["y"] * dpi), round(b["width"] * dpi), round(b["height"] * dpi))
        state = (shown, rect)
        if state != last:
            flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED
            x, y, w, h = rect
            user32.SetWindowPos(win, 0, x - SIDE, y - TOP, w + 2 * SIDE, h + TOP + BOTTOM, flags | (SWP_SHOWWINDOW if shown else SWP_HIDEWINDOW))
            user32.SetWindowRgn(win, gdi32.CreateRectRgn(SIDE, TOP, SIDE + w, TOP + h), True)
            print("placed" if shown else "hidden", rect, flush=True); last = state
        time.sleep(0.03)  # ~30 Hz follow when Herdr moves or resizes


if __name__ == "__main__":
    main()
