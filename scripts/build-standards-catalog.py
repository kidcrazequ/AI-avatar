#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为国标及技术文献生成主题化目录索引（精炼层）。
机械抽取：从文件名取标准号+标题，从正文首页取『范围/适用』片段，按关键词归主题。"""
import os, re, json

KN = "/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
SRC = os.path.join(KN, "国标及技术文献")
OUT = os.path.join(SRC, "_国标技术文献-目录索引.md")

# 标准号正则（GB/T、GB、IEC、IEEE、NB/T、T/CEC、CQC、CGC、JT/T、DB 等）
STD_RE = re.compile(r'(GB[\s/_T+\-]*\d{3,5}[\.\-—]?\d*[\.\-]?\d*|IEC[\s_+\-]*\d{3,5}|IEEE[\s_]*(?:Std[\s_]*)?\d{3,4}|NB[\s/_T+\-]*\d{3,5}[\.\d]*|T[\s/]*C[A-Z]{2,4}[\s_+\-]*\d{2,4}|CQC[\s_+\-]*\d{3,4}|CGC[\s/A-Z]*\d{2,4}|JT[\s/_T+\-]*\d{3,5}|DB\d{2})', re.I)

THEMES = [
 ("电化学储能与电池", ["储能","锂离子","锂蓄电","电池","bms","battery","变流器","pcs","构网","预制舱","energy storage"]),
 ("电动汽车与充电设施", ["电动汽车","充电","充电桩","充电机","连接装置","充电模块","传导充电","rdc","互操作","供电设备","电动汽车供电","off-board","conductive charging","液冷电缆"]),
 ("电气安全与防护", ["防雷","接地","电击","防护等级","ip代码","ip代","绝缘配合","绝缘材料","电涌","spd","静电","火灾","探测报警","安全指南","安全要求","电气装置安装"]),
 ("低压电器·配电·电缆", ["低压开关","低压断路器","断路器","低压配电","配电设计","电力电缆","电缆设计","电缆","供电系统","电气一次","电气设计手册","低压供电"]),
 ("电能质量与电力系统", ["电能质量","谐波","电压波动","闪变","安全稳定","电网运行","暂态","harmonic","电力系统"]),
 ("电磁兼容 EMC", ["电磁兼容","emc","抗扰度","静电放电","干扰","屏蔽","interference"]),
 ("环境·可靠性·包装运输试验", ["环境试验","环境条件","盐雾","振动","沙尘","高原","运输","包装","承重","承载","严酷","试验方法","机械和气候","package","transport"]),
 ("虚拟电厂·并网·新能源接入", ["虚拟电厂","并网","光伏","接入配电网","接入低压","物联对接","并网技术","vpp"]),
 ("通信·标识·布线验收", ["通信协议","通讯协议","modbus","can通信","can协议","rfid","识别卡","集成电路卡","图形符号","符号要素","颜色","布线","网络工程","网络安全","数据通信","通信规范"]),
 ("元器件与应用手册", ["半导体","功率","继电器","电量计","igct","直流配电","固态断路器","应用手册","应用指导","designation requirements","converter","plc系统"]),
]

def std_no(name):
    m = STD_RE.search(name)
    if not m: return ""
    s = m.group(1)
    s = re.sub(r'[_]+',' ', s).strip()
    return s.upper().replace("GB T","GB/T").replace("NB T","NB/T").replace("JT T","JT/T")

def scope_snippet(path):
    try:
        txt = open(path, encoding="utf-8").read()
    except Exception:
        return ""
    # 去掉 frontmatter 与标题，取正文前 120 行
    body = re.sub(r'^---.*?---', '', txt, count=1, flags=re.S)
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    for i,l in enumerate(lines[:120]):
        if any(k in l for k in ("本标准规定","本文件规定","本规范规定","适用于","本标准适用","范围")) and len(l) > 8:
            seg = l
            if len(seg) < 24 and i+1 < len(lines): seg += lines[i+1]
            seg = re.sub(r'\s+',' ', seg)
            return seg[:120]
    return ""

def theme_of(name, body_hint):
    low = (name + " " + body_hint).lower()
    for tname, kws in THEMES:
        if any(k in low for k in kws):
            return tname
    return "其他技术文献"

def main():
    buckets = {t[0]: [] for t in THEMES}
    buckets["其他技术文献"] = []
    files = []
    for dp, _, fns in os.walk(SRC):
        for fn in fns:
            if fn.endswith(".md") and not fn.startswith("_"):
                files.append(os.path.join(dp, fn))
    for path in sorted(files):
        rel = os.path.relpath(path, SRC)        # 子目录相对路径
        title = os.path.basename(path)[:-3]
        sn = std_no(title)
        snip = scope_snippet(path)
        th = theme_of(title, snip)
        buckets[th].append((sn, title, rel, snip))
    # 输出
    total = sum(len(v) for v in buckets.values())
    out = []
    out.append("# 国标及技术文献 — 主题目录索引（精炼层）\n")
    out.append("> 本文件是对 `国标及技术文献/` 下全部抽取 md 的主题化目录，便于小凯按主题快速定位标准并引用。\n")
    out.append(f"> 收录 {total} 份；引用具体标准时标注 `[来源: knowledge/国标及技术文献/<文件名>.md]`。\n")
    out.append("> **注意**：标注「需 OCR」「无法解析」的条目正文未入库，引用前需补 OCR/重新导出。\n")
    out.append("\n## 主题速览\n")
    for tname,_ in THEMES:
        out.append(f"- **{tname}**：{len(buckets[tname])} 份")
    out.append(f"- **其他技术文献**：{len(buckets['其他技术文献'])} 份")
    out.append("\n---\n")
    for tname, _ in THEMES + [("其他技术文献", None)]:
        items = buckets[tname]
        if not items: continue
        out.append(f"\n## {tname}（{len(items)} 份）\n")
        out.append("| 标准号 | 标题 | 子目录 | 适用范围摘录 |")
        out.append("|---|---|---|---|")
        for sn, title, rel, snip in sorted(items, key=lambda x: (x[0]=="", x[0])):
            t = title.replace("|","/")
            sub = os.path.dirname(rel).replace("|","/") or "（根）"
            s = (snip or "").replace("|","/") or "—"
            out.append(f"| {sn or '—'} | {t} | {sub} | {s} |")
    content = "\n".join(out) + "\n"
    open(OUT, "w", encoding="utf-8").write(content)
    print("写出目录索引:", OUT)
    print("总计:", total, "| 分主题:", {k:len(v) for k,v in buckets.items() if v})

if __name__ == "__main__":
    main()
