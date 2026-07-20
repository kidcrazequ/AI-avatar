// wigolo 搜索引擎插件：CSDN（so.csdn.net 公开搜索接口）
// 契约见 wigolo docs/plugins.md：导出 searchEngine = { name, search(query, options) }
// 失败语义：网络错误 / 非 200 / JSON 结构大变 → 抛错，由 wigolo 在 engine_telemetry
// 里如实标注该引擎失败；真的无结果才返回 []。
// 独立 ESM 模块：零 npm 依赖，只用 Node >= 20 内置能力（全局 fetch + AbortSignal.timeout）。

const ENGINE_NAME = 'csdn';

// 与 bing-cn 插件一致的桌面 Chrome UA（各插件为独立模块，不共享代码，故此处复制一份）
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT_MS = 10_000;

/** 解码常见 HTML 实体（数字实体先解，&amp; 最后解，避免二次解码） */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 剥掉 HTML 标签（含 CSDN 的 <em> 高亮标签）并解码实体，压缩空白 */
function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

export const searchEngine = {
  name: ENGINE_NAME,

  async search(query, _options) {
    const searchUrl =
      `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(query)}&t=all&p=1`;

    // 网络错误（DNS/超时/连接重置）直接向上抛，wigolo 侧如实记录
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`[${ENGINE_NAME}] HTTP ${res.status} for ${searchUrl}`);
    }

    const bodyText = await res.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const err = new Error(`[${ENGINE_NAME}] 响应不是合法 JSON，接口结构可能已变`);
      err.responseSnippet = bodyText.slice(0, 500);
      throw err;
    }

    // 结构大变（没有 result_vos 数组）→ 抛错而不是静默返回空
    if (!Array.isArray(data.result_vos)) {
      const err = new Error(
        `[${ENGINE_NAME}] 响应 JSON 缺少 result_vos 数组，接口结构可能已变` +
        `（keys=${Object.keys(data).join(',')}）`,
      );
      err.responseSnippet = bodyText.slice(0, 500);
      throw err;
    }

    const results = [];
    for (const item of data.result_vos) {
      // url_location 优先，缺失时退回 url 字段；两者都没有的条目过滤掉
      const url = item.url_location || item.url;
      if (!url) continue;
      results.push({
        title: stripHtml(item.title), // 剥掉 <em>/</em> 高亮标签
        url,
        snippet: stripHtml(item.description),
        // 按排名递减：1 - i * 0.05，下限 0.5（与 bing-cn 同规则）
        relevance_score: Math.max(0.5, 1 - results.length * 0.05),
        engine: ENGINE_NAME,
      });
    }
    return results;
  },
};
