"""Turns the R&D screenshots into the images under repo/docs/images.

Crops to the part that matters, scales down, and covers local file:// URLs (they show the
author's folders) with a neutral "file:///…/test.html".
"""
import os
from PIL import Image, ImageDraw, ImageFont

SRC = os.environ.get("SHOTS", os.getcwd())  # the folder with the raw screenshots
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "images")
os.makedirs(OUT, exist_ok=True)
FONT = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 13)
FIELD = (33, 26, 51)


def url_band(im):
    """Rows of the address field whose text starts at x≈442 (the local test page's file:// URL)."""
    W, _ = im.size
    rows = []
    for y in range(95, 165):
        xs = [x for x in range(380, W - 200) if sum(im.getpixel((x, y))) > 500]
        if len(xs) > 15 and 440 <= min(xs) <= 446 and im.getpixel((min(xs) - 5, y)) == FIELD:
            rows.append(y)
    return (min(rows), max(rows)) if rows else None


def redact(im):
    b = url_band(im)
    if not b:
        return im
    d = ImageDraw.Draw(im)
    d.rectangle([438, b[0] - 4, 775, b[1] + 4], fill=FIELD)
    d.text((442, b[0] - 3), "file:///…/test.html", fill=(226, 222, 236), font=FONT)
    return im


def save(name, im, width=None):
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im = im.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    p = os.path.join(OUT, name)
    im.save(p, optimize=True)
    print(f"{name:34} {im.size}  {os.path.getsize(p) // 1024} KB")


def load(f, do_redact=False):
    im = Image.open(os.path.join(SRC, f)).convert("RGB")
    return redact(im) if do_redact else im


# --- research ---
save("rnd-a-first-frames.png", load("shotA5.png"), 900)
save("rnd-c-chrome-window-over-herdr.png", load("shotC2-1.png"), 900)
save("rnd-c2-clipped-window.png", load("shotC4.png"), 900)
save("rnd-flicker-test-page.png", load("shotE2.png").crop((315, 55, 1270, 760)), 900)
grabs = [Image.open(os.path.join(SRC, f"flick-{i}.png")).convert("RGB").resize((260, 260)) for i in range(4)]
strip = Image.new("RGB", (4 * 266 - 6, 260), (24, 20, 34))
for i, g in enumerate(grabs):
    strip.paste(g, (i * 266, 0))
save("rnd-flicker-grabs.png", strip)

# --- hands-on tests in Herdr ---
save("test-hands-on-start.png", load("shotT0.png", True), 900)
save("test-hands-on-result.png", load("shotT1.png", True), 900)
save("test-dropdown-debug-box.png", load("shotP12.png", True), 900)
save("test-dropdown-open.png", load("shotP13.png", True), 900)
save("test-plus-menu.png", load("crop_menu.png"), 400)
save("test-dialog.png", load("shotD1.png").crop((315, 55, 2550, 760)), 1100)
s08 = load("agentshots/s08.png", True)
save("test-agent-driving.png", s08, 900)
save("test-agent-badge.png", s08.crop((315, 85, 1272, 165)))
save("test-agent-done.png", load("agentshots/s45.png", True), 900)
