// wigolo 国内引擎插件冒烟测试（真实联网）
// 用法：node scripts/wigolo-plugins/smoke.mjs "查询词"（默认"储能 电池"）
// 通过标准：两个引擎都返回 >= 1 条"与查询词相关"的结果 → exit 0；
// 任一引擎抛错 / 0 结果 / 结果疑似风控罐头（见下）→ 打印诊断并 exit 1。
//
// 罐头结果检测：实测 bing 被风控时会返回结构完整（含 b_algo 块）但内容与查询完全
// 无关的固定结果页（如中文查询返回西语 Bing 宣传页）。插件按契约无法区分这种
// "结构正常的假结果"，冒烟侧用最粗的相关性检查兜底：所有结果的 title+snippet+url
// 拼起来若不含查询词的任何一个空白分隔 token，判为疑似罐头 → 失败（fail-loud）。

const query = process.argv[2] || '储能 电池';

const PLUGINS = ['bing-cn', 'csdn'];

// 查询词按空白切 token，过滤空串；CJK token 直接做子串匹配即可
const queryTokens = query.split(/\s+/).filter(Boolean);

/** 所有结果拼成一段文本后，查询词的任一 token 是否出现过 */
function anyTokenPresent(results) {
  const haystack = results
    .map((r) => `${r.title} ${r.snippet} ${r.url}`)
    .join(' ')
    .toLowerCase();
  return queryTokens.some((t) => haystack.includes(t.toLowerCase()));
}

let failed = false;

for (const dir of PLUGINS) {
  const modUrl = new URL(`./${dir}/index.mjs`, import.meta.url);
  try {
    const { searchEngine } = await import(modUrl.href);
    const results = await searchEngine.search(query, {});
    console.log(`[${searchEngine.name}] 结果数: ${results.length}`);
    if (results.length === 0) {
      // 引擎没抛错但零结果：对冒烟查询词而言同样视为失败（fail-loud）
      console.error(`[${searchEngine.name}] 失败：返回 0 条结果`);
      failed = true;
      continue;
    }
    if (!anyTokenPresent(results)) {
      console.error(
        `[${searchEngine.name}] 失败：${results.length} 条结果均不含查询词任一 token` +
        `（${queryTokens.join(' / ')}），疑似风控罐头结果页`,
      );
      console.error(
        `[${searchEngine.name}] 结果标题采样：` +
        results.slice(0, 3).map((r) => JSON.stringify(r.title)).join(', '),
      );
      failed = true;
      continue;
    }
    const first = results[0];
    console.log(`  第一条: ${JSON.stringify({
      title: first.title,
      url: first.url,
      snippet: (first.snippet || '').slice(0, 80),
    }, null, 2)}`);
  } catch (err) {
    failed = true;
    console.error(`[${dir}] 失败：${err.message}`);
    if (err.responseSnippet) {
      console.error(`[${dir}] 响应片段：${err.responseSnippet}`);
    }
  }
}

process.exit(failed ? 1 : 0);
