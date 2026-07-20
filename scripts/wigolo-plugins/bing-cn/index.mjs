// wigolo 搜索引擎插件：必应中国（cn.bing.com）
// 契约见 wigolo docs/plugins.md：导出 searchEngine = { name, search(query, options) }
// 失败语义：网络错误 / 非 200 / 页面结构大变（疑似风控）→ 抛错，由 wigolo 在
// engine_telemetry 里如实标注该引擎失败；真的无结果才返回 []。
// 独立 ESM 模块：零 npm 依赖，只用 Node >= 20 内置能力（全局 fetch + AbortSignal.timeout）。

const ENGINE_NAME = 'bing-cn';

// 桌面 Chrome 完整 UA（降低被判定为脚本流量的概率）
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
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ') // bing 摘要里日期分隔常出现 &ensp;
    .replace(/&amp;/g, '&');
}

/** 剥掉 HTML 标签并解码实体，压缩空白 */
function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * 把返回页面按 <li class="b_algo"> 切成结果块。
 * 不引入 HTML 解析库，用切分而非嵌套匹配：每块从一个 b_algo 开头到下一个 b_algo（或文末），
 * 后续对标题/摘要的正则只取块内第一次命中，块尾多余内容无影响。
 */
function splitAlgoBlocks(html) {
  const parts = html.split('<li class="b_algo"');
  return parts.slice(1); // parts[0] 是页面头部，非结果
}

/** 从单个结果块提取 { title, url, snippet }；结构不符返回 null */
function parseAlgoBlock(block) {
  // 标题与链接：<h2><a ... href="...">标题</a></h2>
  const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if (!titleMatch) return null;
  const url = decodeEntities(titleMatch[1]); // bing 中间跳转链接（/ck/a）保持原样，v1 不解包
  const title = stripHtml(titleMatch[2]);
  if (!url || !title) return null;

  // 摘要：class 含 b_caption 或 b_lineclamp 的 <p>
  const snippetMatch = block.match(
    /<p[^>]*class="[^"]*(?:b_caption|b_lineclamp)[^"]*"[^>]*>([\s\S]*?)<\/p>/,
  );
  const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

  return { title, url, snippet };
}

/** 无结果块时判断是否命中验证码/人机验证页特征 */
function looksLikeCaptcha(html) {
  return /captcha|verify|challenge|人机验证|安全验证|异常流量/i.test(html);
}

export const searchEngine = {
  name: ENGINE_NAME,

  async search(query, _options) {
    const searchUrl =
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=10`;

    // 网络错误（DNS/超时/连接重置）直接向上抛，wigolo 侧如实记录
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`[${ENGINE_NAME}] HTTP ${res.status} for ${searchUrl}`);
    }

    const html = await res.text();
    const blocks = splitAlgoBlocks(html);

    if (blocks.length === 0) {
      // 页面里一个 b_algo 都没有：区分"疑似风控页"和"真的零结果"
      if (looksLikeCaptcha(html)) {
        const err = new Error(
          `[${ENGINE_NAME}] 页面无 b_algo 结果块且含验证码/人机验证特征，疑似被风控` +
          `（status=${res.status}, bytes=${html.length}）`,
        );
        // 附带响应片段方便上层诊断（smoke.mjs 会打印）
        err.responseSnippet = html.slice(0, 500);
        throw err;
      }
      return []; // 真无结果
    }

    const results = [];
    for (const block of blocks) {
      const parsed = parseAlgoBlock(block);
      if (!parsed) continue;
      results.push({
        title: parsed.title,
        url: parsed.url,
        snippet: parsed.snippet,
        // 按排名递减：1 - i * 0.05，下限 0.5
        relevance_score: Math.max(0.5, 1 - results.length * 0.05),
        engine: ENGINE_NAME,
      });
    }
    return results;
  },
};
