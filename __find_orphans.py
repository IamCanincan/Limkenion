import os
import io
import re

ROOT = '.'
SKIP = ('node_modules', '.git', 'dist', 'web', '.workbuddy-ai')

srcs = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    parts = dirpath.replace(os.sep, '/').split('/')
    if any(s in parts for s in SKIP):
        dirnames[:] = []
        continue
    for fn in filenames:
        if not fn.endswith(('.ts', '.tsx')):
            continue
        p = os.path.join(dirpath, fn).replace(os.sep, '/').lstrip('./')
        try:
            srcs.append((p, io.open(p, encoding='utf-8').read()))
        except Exception:
            pass

# 所有被引用的模块说明符（静态 import / 动态 import / require / typeof import）
# 注意：[^'"\n]+ 必须排除换行 —— 否则注释里出现的 from 会一路吞到很后面的引号，
# 把中间的 import 行整个吃掉（这个 bug 让 cli/print.ts 被误判成孤儿）。
SPEC = re.compile(r"""(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]""")

referenced = set()
for _, content in srcs:
    for m in SPEC.finditer(content):
        spec = m.group(1)
        # 相对路径与 src/ 别名都要归一成 basename（项目里两种写法都有）
        referenced.add(os.path.basename(spec))
        referenced.add(spec)

print(f'收集到 {len(referenced)} 个被引用的模块名\n')

# 找完全没有被引用的源码文件（排除入口/类型声明/测试等）
ENTRY_HINTS = ('main.tsx', 'index.ts', 'index.tsx', 'mod.ts')
orphans = []
for path, content in srcs:
    base = os.path.basename(path)
    stem = base.rsplit('.', 1)[0]
    if stem in ('main', 'index', 'mod'):
        continue
    if base.endswith('.d.ts'):
        continue
    if stem in referenced or (stem + '.js') in referenced or (stem + '.ts') in referenced:
        continue
    orphans.append(path)

print(f'没有任何模块引用它的文件: {len(orphans)} 个')
for o in sorted(orphans):
    print('  ' + o)
