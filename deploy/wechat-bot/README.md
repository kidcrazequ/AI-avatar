# 小堵 - 企业微信机器人部署指南

## 架构

```
企业微信用户 → 企业微信应用 → 你的后端服务 → Claude API → 返回回复
```

## 部署步骤

### 1. 企业微信配置

1. 登录企业微信管理后台：https://work.weixin.qq.com/
2. 进入「应用管理」→「自建」→「创建应用」
3. 填写应用信息：
   - 应用名称：小堵
   - 应用 Logo：上传一个图标
4. 创建后记录以下信息：
   - `AgentId`：应用 ID
   - `Secret`：应用密钥
   - `CorpId`：企业 ID（在「我的企业」页面）

5. 配置接收消息：
   - 进入应用详情 → 「接收消息」→「设置API接收」
   - URL：`https://你的域名/wechat/callback`
   - Token：随机生成一个字符串（如 `xiaodu_token_2026`）
   - EncodingAESKey：点击「随机获取」

### 2. 准备 Claude API Key

1. 访问 https://console.anthropic.com/
2. 创建 API Key
3. 记录 API Key

### 3. 部署后端服务

#### 方式一：本地运行（测试用）

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入上面记录的信息

# 运行服务
python app.py
```

#### 方式二：Docker 部署（推荐）

```bash
# 构建镜像
docker build -t xiaodu-wechat-bot .

# 运行容器
docker run -d \
  --name xiaodu-bot \
  -p 8000:8000 \
  --env-file .env \
  xiaodu-wechat-bot
```

#### 方式三：云服务器部署

推荐使用：
- 阿里云 ECS / 腾讯云 CVM
- 或者 Railway / Render 等 PaaS 平台

### 4. 配置域名和 HTTPS

企业微信要求回调地址必须是 HTTPS，可以使用：
- Nginx + Let's Encrypt 证书
- 或者云服务商提供的负载均衡 + SSL 证书

### 5. 验证配置

1. 在企业微信「接收消息」页面点击「保存」
2. 企业微信会向你的服务器发送验证请求
3. 如果配置正确，会显示「验证成功」

### 6. 测试使用

1. 在企业微信中找到「小堵」应用
2. 发送消息测试：
   ```
   广东工商储现在值得做吗？
   ```
3. 小堵会以上海人的口吻回复你

## 成本估算

- **服务器**：最低配 1核2G，约 ¥50-100/月
- **Claude API**：按 token 计费
  - Input: $3/M tokens
  - Output: $15/M tokens
  - 预估：每天 100 次对话，约 $10-20/月

## 常见问题

### Q1: 企业微信验证失败
检查：
- URL 是否可访问（公网 IP + HTTPS）
- Token 和 EncodingAESKey 是否正确
- 服务是否正常运行

### Q2: 机器人不回复
检查：
- 后端日志是否有报错
- Claude API Key 是否有效
- 是否有网络问题（需要能访问 api.anthropic.com）

### Q3: 回复太慢
- Claude API 响应时间约 2-5 秒
- 可以先回复"正在思考..."，然后异步返回结果
- 或者使用 Claude Haiku 模型（更快但能力稍弱）

## 维护

- 定期查看日志：`docker logs xiaodu-bot`
- 监控 API 用量：https://console.anthropic.com/
- 更新小堵的知识库：修改 `prompt.txt` 后重启服务
