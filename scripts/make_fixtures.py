# -*- coding: utf-8 -*-
"""生成 E2E 演示工作区的富媒体测试素材（图片/PDF/xlsx/wav/H.264 mp4/文本）。"""
import os, sys, math, wave, struct, subprocess, json, shutil

BASE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(BASE, '..', '.e2e', 'ws')
PRJ = os.path.join(WS, '2026-09-13_山雾咖啡_秋季新品')
os.makedirs(os.path.join(PRJ, '视频'), exist_ok=True)
os.makedirs(os.path.join(PRJ, '平面'), exist_ok=True)
os.makedirs(os.path.join(PRJ, '文案'), exist_ok=True)

from PIL import Image, ImageDraw

def gradient(w, h, c1, c2):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        col = tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))
        d.line([(0, y), (w, y)], fill=col)
    return img

def make_poster(path, w, h, c1, c2, label):
    img = gradient(w, h, c1, c2)
    d = ImageDraw.Draw(img)
    d.ellipse([w*0.28, h*0.22, w*0.72, h*0.66], fill=(250, 247, 240), outline=(60, 50, 40), width=4)
    d.rectangle([w*0.2, h*0.75, w*0.8, h*0.88], fill=(30, 30, 30))
    img.save(path, quality=90)
    print('图:', path)

make_poster(os.path.join(PRJ, '平面', '主视觉.png'), 1280, 720, (14, 90, 82), (210, 228, 220), '主视觉')
make_poster(os.path.join(PRJ, '平面', '海报.jpg'), 800, 1200, (194, 58, 23), (250, 237, 231), '海报')
make_poster(os.path.join(PRJ, '平面', '详情页头图.jpg'), 1200, 480, (30, 43, 39), (120, 148, 138), '详情页')

# PDF（PIL 栅格 PDF）
make_poster(os.path.join(PRJ, '文案', '提案封面.pdf'), 1240, 1754, (240, 238, 230), (200, 208, 202), '提案')
print('PDF:', os.path.join(PRJ, '文案', '提案封面.pdf'))

# xlsx
from openpyxl import Workbook
wb = Workbook()
ws1 = wb.active
ws1.title = '报价'
ws1.append(['产品', '规格', '数量', '单价'])
for i, (n, s, q, p) in enumerate([('桂花拿铁', '16oz', 200, 22), ('冷萃', '500ml', 300, 18), ('挂耳礼盒', '10包', 150, 68)]):
    ws1.append([n, s, q, p])
wb.save(os.path.join(PRJ, '文案', '产品报价.xlsx'))
print('xlsx ok')

# 文案
with open(os.path.join(PRJ, '文案', '口播文案.md'), 'w', encoding='utf-8') as f:
    f.write('# 秋季新品口播文案\n\n清晨的第一口桂花香，从山雾咖啡开始。\n\n- 镜头 1：晨雾中的店面\n- 镜头 2：桂花拿铁特写\n- 镜头 3：吧台手冲过程\n')
print('md ok')

# wav 旁白（4 秒 440Hz 渐弱正弦）
wav_path = os.path.join(PRJ, '视频', '旁白.wav')
with wave.open(wav_path, 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
    frames = b''.join(struct.pack('<h', int(12000 * math.sin(2 * math.pi * 440 * i / 44100) * (1 - i / 44100 / 4))) for i in range(44100 * 4))
    w.writeframes(frames)
print('wav ok')

# H.264 mp4（10 秒 640x360，测试帧 + 呼吸色块，Chrome 可直接播放）
ff = None
try:
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    pass
mp4 = os.path.join(PRJ, '视频', '产品片_粗剪.mp4')
if ff:
    vf = ("drawbox=x=120:y=90:w=160:h=120:color=white@0.8:t=fill,"
          "drawbox=x=360:y=90:w=160:h=120:color=0xE0E8E4@0.9:t=fill")
    cmd = [ff, '-y', '-f', 'lavfi', '-i', f'testsrc2=size=640x360:rate=24:duration=10',
           '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10', '-vf', vf,
           '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '96k', '-shortest', mp4]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print('mp4 ok:', mp4, os.path.getsize(mp4), 'bytes')
    except subprocess.CalledProcessError as e:
        print('libx264 失败，回退 mpeg4：', e.stderr[-300:])
        raise SystemExit(2)
else:
    print('no ffmpeg'); raise SystemExit(2)

# 一个较大的文件用于观察传输进度（约 30MB 伪视频素材）
big = os.path.join(PRJ, '视频', '素材_转场包.mp4')
with open(big, 'wb') as f:
    chunk = os.urandom(1024 * 1024)
    for i in range(30):
        f.write(chunk)
print('big ok')

# 工作区里放一个干扰文件夹（不应成为项目）
os.makedirs(os.path.join(WS, '随手记'), exist_ok=True)
with open(os.path.join(WS, '随手记', 'note.txt'), 'w', encoding='utf-8') as f:
    f.write('不是项目')
print('ALL FIXTURES DONE ->', PRJ)
