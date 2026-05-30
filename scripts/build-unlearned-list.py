#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""汇总「未学习文件」清单 + 问题分析，写到 knowledge/_未学习文件清单.md。
来源：_ingest-report.json（顶层跳过/损坏）+ 重新列出 40 个压缩包成员（归档内跳过）。
按「问题类别」归类，标注原因与能否补救。"""
import json, os, subprocess, zipfile
from collections import defaultdict

ROOT="/Users/kian/备份/AI/soul"
KN=os.path.join(ROOT,"avatars","小凯-电气工程师","knowledge")
DL="/Users/kian/Downloads/"
import importlib.util
spec=importlib.util.spec_from_file_location("ing",os.path.join(ROOT,"scripts","ingest-xiaokai-knowledge.py"))
ing=importlib.util.module_from_spec(spec); spec.loader.exec_module(ing)
CONV=ing.CONV
ALREADY_LEARNED_EXT={'.md','.html'}   # 本轮已补收的可学习类型
SRC_MAP={"00 国标及技术文献":"国标及技术文献","工作小结":"工作小结","工商业储能":"工商业储能","超充桩":"超充桩"}

def learned_md_path(p):
    """该源文件是否已有对应知识 md（图片 OCR / 媒体 ASR 等补学后会生成）。"""
    rel=os.path.relpath(p,DL); parts=rel.split(os.sep)
    if parts[0] in SRC_MAP and len(parts)>1:
        return os.path.join(KN,SRC_MAP[parts[0]],os.path.splitext(os.path.join(*parts[1:]))[0]+".md")
    return None
def is_learned(p):
    m=learned_md_path(p)
    return bool(m and os.path.exists(m))

# ext -> (类别, 问题说明, 能否补救/如何补救)
CAT={}
def reg(exts,cat,prob,rem):
    for e in exts: CAT[e]=(cat,prob,rem)
reg(['.dwg','.dxf'],"CAD 二维图纸","矢量 CAD 图纸（二进制），非文本无法直接读取；常含接线图/尺寸/线束等工程信息","可补救：用 CAD 软件导出 PDF/DXF 文本，或将图纸视图截图后走 OCR/多模态识别")
reg(['.step','.stp','.stl','.igs','.iges','.sldprt'],"CAD 三维模型","三维几何模型，本身无文字内容","一般无需学习；若需尺寸/物料，改取设计 BOM 或图纸明细表")
reg(['.jpg','.jpeg','.png','.gif','.bmp','.tif','.tiff'],"图片（位图）","位图图片，需 OCR/多模态识别才能转文本（本批未对独立图片做 OCR）","可补救：对图片跑 macOS Vision OCR / 多模态识别，识别后回写 markdown")
reg(['.mp4','.avi','.mov','.mkv','.flv','.wmv'],"视频","音视频文件，需语音转写(ASR)+抽帧 OCR 才能提取知识","可补救：用 ASR 转写（如友商维护/充电指导视频含操作讲解，有学习价值）")
reg(['.mp3','.wav','.wma','.m4a'],"音频","音频文件，需 ASR 语音转写","可补救：ASR 转写为文本后入库")
reg(['.dll','.exe','.lib','.so','.a','.bin','.o','.obj'],"程序二进制/库","编译产物/可执行文件/静态库，无知识文本","无学习价值，建议忽略")
reg(['.cpp','.h','.c','.hpp','.cc','.pro','.sln','.cmake'],"源代码/构建脚本","出厂测试程序的源码/构建脚本，属软件资产非领域知识","无领域学习价值；如需代码理解请单独走代码库")
reg(['.qm','.ts'],"Qt 翻译资源","Qt 国际化翻译二进制/源，无领域内容","无学习价值")
reg(['.dat','.pfd','.scu','.db','.stash','.idx'],"二进制数据","私有/二进制数据文件，无可读文本结构","无学习价值，除非另有格式规范说明")
reg(['.release','.debug','.temp','.tmp','.0'],"构建/临时产物","编译中间产物/临时文件","无学习价值")
reg(['.crdownload','.part','.download'],"未下载完成","浏览器未下载完成的残件，文件不完整","可补救：重新完整下载后再学习")
reg(['.url','.webloc','.lnk'],"网址/快捷方式","仅是一个链接/快捷方式，本身无内容","可补救：打开链接抓取目标网页内容")
reg(['.zip','.rar','.7z'],"压缩包","压缩容器本身非文本","已处理：本批已解压并学习其中文本（见 _archive-ingest-report.json）")
reg(['.dwl','.dwl2'],"CAD 锁文件","AutoCAD 打开图纸时生成的锁文件，无内容","无学习价值（对应 .dwg 图纸另见 CAD 类）")

def cat_of(path):
    b=os.path.basename(path)
    if b.startswith("~$"): return ("Office 临时锁","Office 打开文档时生成的临时锁文件","无学习价值（对应正式文档已学习）")
    e=os.path.splitext(path)[1].lower()
    if e in CAT: return CAT[e]
    return ("其他/未识别",f"未归类扩展名 {e or '(无)'}，多为二进制或专有格式","需人工核查该文件是否含可读文本")

def list_archive(a):
    e=os.path.splitext(a)[1].lower()
    out=[]
    try:
        if e==".zip":
            with zipfile.ZipFile(a) as z:
                for info in z.infolist():
                    if info.is_dir(): continue
                    n=info.filename
                    if not (info.flag_bits & 0x800):
                        try: n=n.encode("cp437").decode("gbk")
                        except: pass
                    out.append(n)
        else:
            r=subprocess.run(["bsdtar","-tf",a],capture_output=True)
            for line in r.stdout.decode("utf-8","replace").splitlines():
                if line and not line.endswith("/"): out.append(line)
    except Exception:
        pass
    return out

def main():
    ing_rep=json.load(open(os.path.join(KN,"_ingest-report.json")))
    arc_rep=json.load(open(os.path.join(KN,"_archive-ingest-report.json")))
    # 分类容器： 类别 -> list[(显示路径, 问题, 补救)]
    buckets=defaultdict(list)
    # 顶层跳过（排除本轮已补学的 md/html）
    skip_top=0
    for p,_ in ing_rep["skipped"]:
        e=os.path.splitext(p)[1].lower()
        if e in ALREADY_LEARNED_EXT: continue
        if is_learned(p): continue          # 图片 OCR / 媒体 ASR 后已学，剔除
        cat,prob,rem=cat_of(p)
        buckets[(cat,prob,rem)].append(p.replace(DL,""))
        skip_top+=1
    # 归档内成员（重列 40 个压缩包，取非文本成员）
    archives=[p for p,_ in ing_rep["skipped"] if p.lower().endswith((".zip",".rar",".7z"))]
    arc_skip=0; per_arc_cap=30
    for a in archives:
        members=list_archive(a)
        shown=0
        arel=a.replace(DL,"")
        for m in members:
            e=os.path.splitext(m)[1].lower()
            if e in CONV: continue                 # 文本类，已学习
            if e in (".zip",".rar",".7z"): continue # 嵌套包另算
            cat,prob,rem=cat_of(m)
            if shown<per_arc_cap:
                buckets[(cat,prob,rem)].append(f"{arel} :: {m}")
            shown+=1; arc_skip+=1
        if shown>per_arc_cap:
            k=("（归档内大量同类文件）","单个压缩包内非文本文件过多，仅展示前 30 个","见原压缩包")
            buckets[k].append(f"{arel} :: …另有 {shown-per_arc_cap} 个非文本文件未逐一列出")
    # 输出
    L=["# 未学习文件清单与问题分析（补救后）\n",
       f"> 更新于 2026-05-30（补救轮）。本文件汇总 4 个源目录里**仍未转入知识库**的文件，并说明每类问题与能否补救。\n",
       f"> 统计：顶层仍未学 **{skip_top}** 个 + 压缩包内非文本约 **{arc_skip}** 个 + 损坏/加密/老格式 **15** 个（详见 `_无法解析原件清单.md`）。\n",
       "> **已完成的补救**：图片 112 张已 OCR、视频/音频 75 个已 ASR 转写、1 个 .md + 2 个 .html 已补收、url 已登记参考——这些已从下表剔除。\n",
       "> **仍未学的两大类**：① CAD dwg 117 个（本环境无转换器，已单列 `_待处理CAD图纸清单.md`）；② 纯二进制/构建产物/未下完残件（无学习价值或无法补）。\n",
       "\n## 一、问题分类总览\n",
       "| 问题类别 | 数量 | 问题说明 | 能否补救 |","|---|---|---|---|"]
    # 汇总每类数量
    order=sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    for (cat,prob,rem),items in order:
        L.append(f"| {cat} | {len(items)} | {prob} | {rem} |")
    # 可补学 vs 无价值 小结
    L+=["\n## 二、按「能否补学」归纳\n",
        "**可后续补学（需额外工具）**：",
        "- 图片（位图）→ Vision OCR / 多模态识别",
        "- CAD 二维图纸（dwg/dxf）→ 导出 PDF 或截图 OCR",
        "- 视频 / 音频 → ASR 语音转写（友商维护/充电指导视频有讲解价值）",
        "- 未下载完成（crdownload）→ 重新下载",
        "- 网址快捷方式（url）→ 抓取链接目标",
        "\n**无学习价值（建议忽略）**：程序二进制/库、源码/构建脚本、Qt 翻译、二进制数据、构建/临时产物、Office 临时锁、CAD 三维模型。",
        "\n**需人工修复**：损坏/加密/老格式 15 份，见 `_无法解析原件清单.md`。\n",
        "\n## 三、明细清单（按类别）\n"]
    for (cat,prob,rem),items in order:
        L.append(f"\n### {cat}（{len(items)}）\n")
        L.append(f"_问题：{prob}　|　{rem}_\n")
        for it in sorted(items):
            L.append(f"- {it.replace('|','/')}")
    out=os.path.join(KN,"_未学习文件清单.md")
    open(out,"w",encoding="utf-8").write("\n".join(L)+"\n")
    print("写出:",out)
    print("顶层非文本:",skip_top,"| 归档内非文本:",arc_skip,"| 类别数:",len(buckets))

if __name__=="__main__": main()
