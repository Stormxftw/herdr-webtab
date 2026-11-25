import os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)), time
from PIL import Image
x,y,w,h = map(int, sys.argv[1:5])
blank = 0; shots = []
for i in range(10):
    out = os.path.join(HERE, f"flick-{i}.png")
    subprocess.run(["powershell","-NoProfile","-ExecutionPolicy","Bypass","-File",os.path.join(HERE, "grab.ps1"),str(x),str(y),str(w),str(h),out],capture_output=True)
    im = Image.open(out).convert("L"); px = list(im.getdata()); white = sum(1 for p in px if p > 240) / len(px)
    shots.append(round(white,2)); blank += white < 0.3
print("white fraction per grab:", shots, "| blank-looking grabs:", blank)
