import { create } from 'zustand'

export type ThemeId =
  // ── 原有 31 个 ──
  | 'pixel-led' | 'blade-runner' | 'grand-budapest' | 'the-matrix'
  | 'mood-for-love' | 'interstellar' | 'dune' | 'la-la-land'
  | 'totoro' | 'parasite' | 'spirited-away' | 'godfather'
  | 'drive' | 'tron-legacy' | 'amelie' | 'akira'
  | 'her' | 'ex-machina' | 'fury-road' | 'moonlight'
  | 'kill-bill' | 'stalker' | 'suspiria' | 'your-name'
  | 'oldboy' | 'joker' | 'revenant' | 'inception'
  | 'space-odyssey' | 'shining' | 'neon-demon'
  // ── 新增 50 个 ──
  | 'oppenheimer' | 'arrival' | 'midsommar' | 'moonrise-kingdom'
  | 'whiplash' | 'sicario' | 'gone-girl' | 'black-swan'
  | 'handmaiden' | 'portrait-fire' | 'hereditary' | 'under-skin'
  | 'phantom-thread' | 'burning' | 'nomadland' | 'roma'
  | 'social-network' | 'there-will-be-blood' | 'mulholland-drive' | 'mandy'
  | 'enter-void' | 'good-time' | 'uncut-gems' | 'annihilation'
  | 'florida-project' | 'prisoners' | 'waves' | 'asteroid-city'
  | 'power-of-dog' | 'favourite' | 'witch' | 'first-reformed'
  | 'nope' | 'barbie' | 'everything-everywhere' | 'batman-2022'
  | 'spencer' | 'tree-of-life' | 'spring-breakers' | 'memoria'
  | 'wicked' | 'aftersun' | 'past-lives' | 'lighthouse'
  | 'color-out-space' | 'crimes-future' | 'only-god-forgives'
  | 'swiss-army-man' | 'blade-runner-2049' | 'isle-of-dogs'

export interface ThemeInfo {
  id: ThemeId
  name: string
  nameEn: string
  description: string
  isDark: boolean
}

export const THEMES: ThemeInfo[] = [
  // ═══════════════ 默认 ═══════════════
  { id: 'pixel-led', name: 'Pixel LED', nameEn: 'Pixel LED', description: '粉色点阵 × void-black — 默认 CRT 主题', isDark: true },

  // ═══════════════ 赛博朋克 / 科幻 ═══════════════
  { id: 'blade-runner', name: '银翼杀手', nameEn: 'Blade Runner', description: '霓虹橙 × 赛博蓝 — 2019 洛杉矶雨夜', isDark: true },
  { id: 'the-matrix', name: '黑客帝国', nameEn: 'The Matrix', description: '终端绿 × 纯黑 — 从代码雨中醒来', isDark: true },
  { id: 'tron-legacy', name: '创战纪', nameEn: 'TRON: Legacy', description: '数字蓝 × 黑色网格 — 电子世界的光轮追逐', isDark: true },
  { id: 'akira', name: '阿基拉', nameEn: 'AKIRA', description: '新东京红 × 霓虹紫 — 赛博朋克暴走', isDark: true },
  { id: 'ex-machina', name: '机械姬', nameEn: 'Ex Machina', description: '冰川青 × 玻璃白 — AI 意识觉醒的无菌实验室', isDark: true },
  { id: 'blade-runner-2049', name: '银翼杀手2049', nameEn: 'Blade Runner 2049', description: '辐射黄 × 废土灰 — 核冬天后的荒芜拉斯维加斯', isDark: true },
  { id: 'annihilation', name: '湮灭', nameEn: 'Annihilation', description: '异变虹彩 × 水晶紫 — 闪光中的基因折射', isDark: true },
  { id: 'enter-void', name: '遁入虚无', nameEn: 'Enter the Void', description: 'DMT 荧光 × 灵魂黑 — 东京霓虹的灵魂出窍', isDark: true },
  { id: 'under-skin', name: '皮囊之下', nameEn: 'Under the Skin', description: '深渊黑 × 外星白光 — 斯嘉丽的异形凝视', isDark: true },
  { id: 'color-out-space', name: '星之彩', nameEn: 'Color Out of Space', description: '辐射洋红 × 有毒薰衣草 — 外星陨石的诡异光芒', isDark: true },
  { id: 'nope', name: '不', nameEn: 'Nope', description: '午夜靛蓝 × 沙漠棕 — 峡谷上空的不明飞行物', isDark: true },

  // ═══════════════ 太空 / 史诗 ═══════════════
  { id: 'interstellar', name: '星际穿越', nameEn: 'Interstellar', description: '银灰 × 深空蓝 — 穿越虫洞的冷静与敬畏', isDark: true },
  { id: 'dune', name: '沙丘', nameEn: 'Dune', description: '香料金 × 弗雷曼蓝 — 厄拉科斯的沙漠风暴', isDark: true },
  { id: 'space-odyssey', name: '2001太空漫游', nameEn: '2001: A Space Odyssey', description: 'HAL 红 × 无菌白 — 人类文明的终极叩问', isDark: true },
  { id: 'inception', name: '盗梦空间', nameEn: 'Inception', description: '钢铁灰 × 陀螺金 — 梦境与现实的折叠', isDark: true },
  { id: 'arrival', name: '降临', nameEn: 'Arrival', description: '迷雾灰 × 外星橘 — 语言学家与七肢桶的对话', isDark: true },
  { id: 'oppenheimer', name: '奥本海默', nameEn: 'Oppenheimer', description: '原子金 × 灰烬蓝 — 三位一体核试验的道德阴影', isDark: true },
  { id: 'tree-of-life', name: '生命之树', nameEn: 'The Tree of Life', description: '宇宙琥珀 × 以太白 — 马利克的创世冥想', isDark: true },

  // ═══════════════ 犯罪 / 悬疑 / 惊悚 ═══════════════
  { id: 'godfather', name: '教父', nameEn: 'The Godfather', description: '琥珀棕 × 暗金 — 权力交接的昏暗书房', isDark: true },
  { id: 'oldboy', name: '老男孩', nameEn: 'Oldboy', description: '毒液绿 × 锈铁 — 15 年密室的复仇执念', isDark: true },
  { id: 'parasite', name: '寄生虫', nameEn: 'Parasite', description: '混凝土灰 × 草坪绿 — 半地下室的冷光', isDark: true },
  { id: 'joker', name: '小丑', nameEn: 'Joker', description: '墨绿 × 腐金 — 哥谭地铁的疯狂笑声', isDark: true },
  { id: 'shining', name: '闪灵', nameEn: 'The Shining', description: '冻蓝 × 血红 — 全景酒店的永恒恐惧', isDark: true },
  { id: 'gone-girl', name: '消失的爱人', nameEn: 'Gone Girl', description: '冰钢蓝 × 有毒绿 — 完美婚姻的精密谎言', isDark: true },
  { id: 'sicario', name: '边境杀手', nameEn: 'Sicario', description: '沙尘黄 × 战术黑 — 华雷斯边境的热浪与死亡', isDark: true },
  { id: 'prisoners', name: '囚徒', nameEn: 'Prisoners', description: '冷雨灰 × 地下室琥珀 — 暴雨中父亲的绝望搜寻', isDark: true },
  { id: 'hereditary', name: '遗传厄运', nameEn: 'Hereditary', description: '窒息棕 × 病态黄 — 微缩模型里的家族诅咒', isDark: true },
  { id: 'mulholland-drive', name: '穆赫兰道', nameEn: 'Mulholland Drive', description: '林奇蓝 × 红丝绒 — 好莱坞梦境的黑色褶皱', isDark: true },
  { id: 'batman-2022', name: '新蝙蝠侠', nameEn: 'The Batman', description: '深红黑 × 摩托车铬 — 哥谭雨夜的复仇幽灵', isDark: true },

  // ═══════════════ 动作 / 风格化 ═══════════════
  { id: 'drive', name: '亡命驾驶', nameEn: 'Drive', description: '霓虹粉 × 暗铬 — 洛杉矶午夜的蝎子夹克', isDark: true },
  { id: 'fury-road', name: '疯狂的麦克斯', nameEn: 'Mad Max: Fury Road', description: '焦土橙 × 铬银 — 末日公路的狂暴追逐', isDark: true },
  { id: 'kill-bill', name: '杀死比尔', nameEn: 'Kill Bill', description: '死亡黄 × 武士黑 — 新娘的复仇之路', isDark: true },
  { id: 'neon-demon', name: '霓虹恶魔', nameEn: 'The Neon Demon', description: '致命紫红 × 深渊蓝 — 洛杉矶时尚界的美丽噩梦', isDark: true },
  { id: 'suspiria', name: '阴风阵阵', nameEn: 'Suspiria', description: '铅蓝红 × 迷幻紫 — 意大利恐怖美学的巅峰', isDark: true },
  { id: 'only-god-forgives', name: '唯神能恕', nameEn: 'Only God Forgives', description: '深红 × 泰拳蓝 — 曼谷地下拳场的暴力仪式', isDark: true },
  { id: 'mandy', name: '曼蒂', nameEn: 'Mandy', description: '迷幻红 × 酸性紫 — 尼古拉斯·凯奇的血色复仇', isDark: true },
  { id: 'good-time', name: '好时光', nameEn: 'Good Time', description: '钠光橙 × 焦虑红 — 纽约长夜的心跳加速', isDark: true },
  { id: 'uncut-gems', name: '原钻', nameEn: 'Uncut Gems', description: '宝石霓虹 × 焦虑黑 — 钻石区的多巴胺过载', isDark: true },
  { id: 'spring-breakers', name: '春假', nameEn: 'Spring Breakers', description: '热带霓虹 × 日落粉 — 佛罗里达的堕落天堂', isDark: true },
  { id: 'everything-everywhere', name: '瞬息全宇宙', nameEn: 'Everything Everywhere', description: '多元宇宙紫 × 贝果米 — 量子跳跃的家庭救赎', isDark: true },

  // ═══════════════ 文艺 / 浪漫 ═══════════════
  { id: 'mood-for-love', name: '花样年华', nameEn: 'In the Mood for Love', description: '旗袍红 × 琥珀 — 昏暗走廊的擦肩而过', isDark: true },
  { id: 'la-la-land', name: '爱乐之城', nameEn: 'La La Land', description: '黄昏紫 × 星光金 — 格里菲斯天文台的星空', isDark: true },
  { id: 'amelie', name: '天使爱美丽', nameEn: 'Amélie', description: '蒙马特绿 × 暖金 — 巴黎小咖啡馆的奇幻日常', isDark: true },
  { id: 'her', name: '她', nameEn: 'Her', description: '柔桃 × 暖红 — 未来洛杉矶的温柔孤独', isDark: true },
  { id: 'moonlight', name: '月光男孩', nameEn: 'Moonlight', description: '深海蓝 × 月光紫 — 迈阿密月色下的沉默成长', isDark: true },
  { id: 'your-name', name: '你的名字', nameEn: 'Your Name', description: '黄昏橙 × 彗星蓝 — 跨越时空的思念', isDark: true },
  { id: 'stalker', name: '潜行者', nameEn: 'Stalker', description: '衰败褐 × 苔藓绿 — 塔可夫斯基的禁区冥想', isDark: true },
  { id: 'revenant', name: '荒野猎人', nameEn: 'The Revenant', description: '冰原蓝 × 原木棕 — 荒野中的求生意志', isDark: true },
  { id: 'portrait-fire', name: '燃烧女子的肖像', nameEn: 'Portrait of a Lady on Fire', description: '烛光金 × 海峡蓝 — 凝视与被凝视的炽热爱情', isDark: true },
  { id: 'burning', name: '燃烧', nameEn: 'Burning', description: '韩国秋棕 × 黄昏橘 — 坡州田野的神秘消失', isDark: true },
  { id: 'phantom-thread', name: '魅影缝匠', nameEn: 'Phantom Thread', description: '薰衣草 × 奶油白 — 伦敦高定工坊的暗潮汹涌', isDark: true },
  { id: 'nomadland', name: '无依之地', nameEn: 'Nomadland', description: '旷野赭 × 天际蓝 — 美国西部的流浪之歌', isDark: true },
  { id: 'aftersun', name: '晒后假日', nameEn: 'Aftersun', description: '褪色青 × 温暖记忆黄 — DV 画质里父女的最后假期', isDark: true },
  { id: 'past-lives', name: '过往人生', nameEn: 'Past Lives', description: '首尔灰蓝 × 纽约暖白 — 隔着 24 年的彼此凝望', isDark: true },
  { id: 'roma', name: '罗马', nameEn: 'Roma', description: '银盐灰 × 柔光白 — 墨西哥城 1970 的黑白记忆', isDark: true },
  { id: 'memoria', name: '记忆', nameEn: 'Memoria', description: '丛林绿 × 远古棕 — 哥伦比亚深处的一声巨响', isDark: true },
  { id: 'waves', name: '浪潮', nameEn: 'Waves', description: '海洋渐变蓝 × 霓虹桃 — 佛罗里达少年的潮汐人生', isDark: true },
  { id: 'spencer', name: '斯宾塞', nameEn: 'Spencer', description: '皇室金 × 冷银 — 圣诞庄园里戴安娜的窒息', isDark: true },

  // ═══════════════ 独立 / 奇幻 ═══════════════
  { id: 'whiplash', name: '爆裂鼓手', nameEn: 'Whiplash', description: '爵士黑金 × 聚光灯白 — 不是我的速度', isDark: true },
  { id: 'black-swan', name: '黑天鹅', nameEn: 'Black Swan', description: '纯黑 × 纯白 × 血痕粉 — 完美主义的精神崩裂', isDark: true },
  { id: 'handmaiden', name: '小姐', nameEn: 'The Handmaiden', description: '翡翠绿 × 丝绸红 — 朝鲜庄园的情欲与骗局', isDark: true },
  { id: 'witch', name: '女巫', nameEn: 'The Witch', description: '清教褐 × 烛火 — 1630 新英格兰的黑暗森林', isDark: true },
  { id: 'first-reformed', name: '第一归正会', nameEn: 'First Reformed', description: '苦修绿 × 教堂石灰 — 牧师的环保末日独白', isDark: true },
  { id: 'favourite', name: '宠儿', nameEn: 'The Favourite', description: '烛光暖 × 宫殿石 — 安妮女王宫廷的权力游戏', isDark: true },
  { id: 'power-of-dog', name: '犬之力', nameEn: 'The Power of the Dog', description: '蒙大拿土 × 冷空蓝 — 牧场上沉默的暗涌', isDark: true },
  { id: 'social-network', name: '社交网络', nameEn: 'The Social Network', description: '哈佛蓝 × 代码灰 — 一个价值百亿的深夜编程', isDark: true },
  { id: 'there-will-be-blood', name: '血色将至', nameEn: 'There Will Be Blood', description: '石油黑 × 烈火橙 — 我喝了你的奶昔', isDark: true },
  { id: 'lighthouse', name: '灯塔', nameEn: 'The Lighthouse', description: '风暴灰 × 油灯黄 — 两个守塔人的疯狂', isDark: true },
  { id: 'crimes-future', name: '未来罪行', nameEn: 'Crimes of the Future', description: '手术台青 × 器官红 — 柯南伯格的身体恐怖', isDark: true },
  { id: 'swiss-army-man', name: '瑞士军刀男', nameEn: 'Swiss Army Man', description: '森林苔绿 × 漂流木 — 荒岛上的奇异友谊', isDark: true },

  // ═══════════════ 浅色主题 ═══════════════
  { id: 'grand-budapest', name: '布达佩斯大饭店', nameEn: 'Grand Budapest Hotel', description: '韦斯安德森粉彩 — 对称构图下的粉色童话', isDark: false },
  { id: 'totoro', name: '龙猫', nameEn: 'My Neighbor Totoro', description: '田园绿 × 天空蓝 — 夏日乡间的风与阳光', isDark: false },
  { id: 'midsommar', name: '仲夏夜惊魂', nameEn: 'Midsommar', description: '日光恐怖 × 花冠白 — 瑞典白夜中的邪教微笑', isDark: false },
  { id: 'moonrise-kingdom', name: '月升王国', nameEn: 'Moonrise Kingdom', description: '童军黄 × 海军蓝 — 韦斯安德森的少年私奔', isDark: false },
  { id: 'barbie', name: '芭比', nameEn: 'Barbie', description: '芭比粉 × 天空蓝 — 塑料世界的完美一天', isDark: false },
  { id: 'asteroid-city', name: '小行星城', nameEn: 'Asteroid City', description: '赤陶橙 × 绿松石 — 韦斯安德森的沙漠戏中戏', isDark: false },
  { id: 'florida-project', name: '佛罗里达乐园', nameEn: 'The Florida Project', description: '魔幻紫 × 日落橘 — 迪士尼边上的童年天堂', isDark: false },
  { id: 'isle-of-dogs', name: '犬之岛', nameEn: 'Isle of Dogs', description: '和纸米 × 浮世绘靛 — 韦斯安德森的日本定格动画', isDark: false },
  { id: 'wicked', name: '魔法坏女巫', nameEn: 'Wicked', description: '翡翠绿 × 泡泡粉 — 奥兹国的善恶双生', isDark: false },

  // ═══════════════ 日本动画 ═══════════════
  { id: 'spirited-away', name: '千与千寻', nameEn: 'Spirited Away', description: '灯笼红 × 金币黄 — 油屋的灯火通明', isDark: true },
]

interface ThemeState {
  themeId: ThemeId
  setTheme: (id: ThemeId) => void
}

const STORAGE_KEY = 'soul-desktop-theme'

function loadSavedTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && THEMES.some(t => t.id === saved)) return saved as ThemeId
  } catch {}
  return 'pixel-led'
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: loadSavedTheme(),
  setTheme: (id) => {
    localStorage.setItem(STORAGE_KEY, id)
    set({ themeId: id })
  },
}))
