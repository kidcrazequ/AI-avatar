# 豆包流式语音输入（Doubao ASR）

> author: zhi.qu  
> date: 2026-05-10

## 官方文档

- 火山引擎语音技术文档入口：https://www.volcengine.com/docs/6561
- 大模型流式 ASR WebSocket 接口以火山引擎控制台实际开通页面为准，当前桌面端默认 endpoint：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`

## 开通与配置

在 Soul 桌面端进入 `Settings -> 工具集成 -> 豆包流式语音输入`，填写：

- `doubao_asr_api_key`：火山引擎 API Key，用于主进程 WebSocket Header `X-Api-Key`。
- `doubao_asr_resource_id`：开通后的 Resource Id，用于 Header `X-Api-Resource-Id`。
- `doubao_asr_endpoint`：可选，默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`。
- `doubao_asr_model`：可选，默认 `bigmodel`。

API Key 只保存在本地 settings 表。渲染进程不会读取 Key，只把麦克风采集到的 16kHz / s16le / mono PCM 分片经 IPC 发给主进程。

## 使用方式

1. 在输入框点击 `语音`。
2. 浏览器内核会请求麦克风权限；Soul 仅允许当前应用页面或开发环境 `http://localhost:5173` 来源。
3. 识别到的 partial transcript 会实时回填到输入框，期间仍可手动编辑。
4. 再次点击 `停止` 结束录音并发送最后一个 audio-only 包。

## 故障排查

- 提示 `豆包 ASR API Key 未配置`：检查 `doubao_asr_api_key`。
- 提示 `豆包 ASR Resource Id 未配置`：检查控制台开通的 Resource Id。
- 提示 endpoint 非法：当前仅允许 `wss://`。
- 没有麦克风权限：检查系统隐私设置，以及是否在 Soul 主窗口内操作。
- 有录音但无文字：确认账号已开通对应 ASR 资源，Resource Id 与 endpoint 匹配，并查看错误日志中的 `doubao-asr` 记录。

## 当前限制

- MVP 只支持单会话互斥录音，不支持多个输入框同时听写。
- 暂不做断线重连、长录音分段恢复、服务端 VAD 配置面板。
- 未在没有真实豆包账号的环境中做端到端识别验收；本地仅覆盖协议、IPC 与 PCM 分片链路。
