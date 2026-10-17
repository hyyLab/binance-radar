#!/usr/bin/env bash
# 校验 docs/strategy-interface.md 中的标识符与源码一致性
# 思路：提取文档中所有 camelCase / SCREAMING_SNAKE / xxx-v1 类 token，
#       对每个 token 在 src/lib 里 grep；找不到的打印出来人工甄别。
set -u
DOC=/home/z/my-project/docs/strategy-interface.md
SRC=/home/z/my-project/src

# 文档示例代码中「本来就该是新的」前缀/名字（允许不在代码中出现）
ALLOW_RE='^(PB_|PULLBACK|Pullback|pullback)'

# 提取 token：camelCase 词、SCREAMING_SNAKE 词、xxx-vN 策略 id
grep -oE '[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]{3,}[A-Z0-9]|[a-z]+-[a-z]+-v[0-9]+' "$DOC" \
  | sort -u > /tmp/doc_tokens.txt

echo "== 文档 token 总数: $(wc -l < /tmp/doc_tokens.txt) =="
echo
echo "== 代码中找不到的 token（人工甄别清单）=="
while IFS= read -r tok; do
  case "$tok" in $ALLOW_RE*) continue;; esac
  # 全词边界搜索源码
  if ! rg -q -w "$tok" "$SRC" 2>/dev/null; then
    echo "MISS  $tok"
  fi
done < /tmp/doc_tokens.txt
echo "== 完 =="
