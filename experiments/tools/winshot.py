"""Capture a window (including child windows) without focusing it: PrintWindow(PW_RENDERFULLCONTENT)."""
import ctypes, ctypes.wintypes as W, sys, struct, zlib

user32 = ctypes.WinDLL("user32"); gdi32 = ctypes.WinDLL("gdi32")
hwnd = int(sys.argv[1], 16); out = sys.argv[2]
r = W.RECT(); user32.GetWindowRect(hwnd, ctypes.byref(r)); w, h = r.right - r.left, r.bottom - r.top
hdc = user32.GetWindowDC(hwnd); mdc = gdi32.CreateCompatibleDC(hdc); bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mdc, bmp); ok = user32.PrintWindow(hwnd, mdc, 2)

class BIH(ctypes.Structure):
    _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG), ("biPlanes", W.WORD), ("biBitCount", W.WORD),
                ("biCompression", W.DWORD), ("biSizeImage", W.DWORD), ("a", W.LONG), ("b", W.LONG), ("c", W.DWORD), ("d", W.DWORD)]
bih = BIH(ctypes.sizeof(BIH), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
buf = ctypes.create_string_buffer(w * h * 4); gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bih), 0)
raw = b"".join(b"\x00" + bytes(buf[y * w * 4:(y + 1) * w * 4]) for y in range(h))
# BGRA -> RGBA
arr = bytearray(raw)
for y in range(h):
    row = y * (w * 4 + 1) + 1
    arr[row:row + w * 4:4], arr[row + 2:row + w * 4:4] = arr[row + 2:row + w * 4:4], arr[row:row + w * 4:4]
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(arr), 6)) + chunk(b"IEND", b"")
open(out, "wb").write(png); print("PrintWindow ok" if ok else "PrintWindow failed", w, h, out)
