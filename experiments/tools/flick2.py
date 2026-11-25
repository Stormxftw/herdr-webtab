import os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
from PIL import Image
x,y,w,h = map(int, sys.argv[1:5]); res=[]
for i in range(20):
    out=os.path.join(HERE, f"flick-{i}.png")
    subprocess.run(["powershell","-NoProfile","-ExecutionPolicy","Bypass","-File",os.path.join(HERE, "grab.ps1"),str(x),str(y),str(w),str(h),out],capture_output=True)
    im=Image.open(out).convert("RGB"); px=im.load()
    purple=sum(1 for yy in range(0,h,4) for xx in range(0,w,4) if px[xx,yy][0]>130 and px[xx,yy][2]>200 and px[xx,yy][1]<140)
    dark=sum(1 for yy in range(0,h,4) for xx in range(0,w,4) if sum(px[xx,yy])<150)
    res.append((purple,dark))
print(res); print("frames with no purple:", sum(1 for p,d in res if p==0), "/", len(res))
