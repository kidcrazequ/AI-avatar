#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小堵 - 企业微信机器人
"""

import os
import logging
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from wechat_handler import WeChatHandler
from claude_client import ClaudeClient

# 加载环境变量
load_dotenv()

# 配置日志
logging.basicConfig(
    level=getattr(logging, os.getenv('LOG_LEVEL', 'INFO')),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 初始化 Flask
app = Flask(__name__)

# 初始化企业微信处理器
wechat = WeChatHandler(
    corp_id=os.getenv('WECHAT_CORP_ID'),
    agent_id=os.getenv('WECHAT_AGENT_ID'),
    secret=os.getenv('WECHAT_SECRET'),
    token=os.getenv('WECHAT_TOKEN'),
    encoding_aes_key=os.getenv('WECHAT_ENCODING_AES_KEY')
)

# 初始化 Claude 客户端
claude = ClaudeClient(
    api_key=os.getenv('CLAUDE_API_KEY'),
    model=os.getenv('CLAUDE_MODEL', 'claude-opus-4-6')
)


@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({'status': 'ok'})


@app.route('/wechat/callback', methods=['GET', 'POST'])
def wechat_callback():
    """企业微信回调接口"""

    if request.method == 'GET':
        # 验证 URL
        try:
            msg_signature = request.args.get('msg_signature')
            timestamp = request.args.get('timestamp')
            nonce = request.args.get('nonce')
            echostr = request.args.get('echostr')

            echo = wechat.verify_url(msg_signature, timestamp, nonce, echostr)
            return echo
        except Exception as e:
            logger.error(f"URL 验证失败: {e}")
            return 'error', 403

    elif request.method == 'POST':
        # 接收消息
        try:
            msg_signature = request.args.get('msg_signature')
            timestamp = request.args.get('timestamp')
            nonce = request.args.get('nonce')

            # 解密消息
            msg = wechat.decrypt_message(
                request.data,
                msg_signature,
                timestamp,
                nonce
            )

            logger.info(f"收到消息: {msg}")

            # 处理文本消息
            if msg.get('MsgType') == 'text':
                user_id = msg.get('FromUserName')
                user_message = msg.get('Content')

                # 调用 Claude API
                reply = claude.chat(user_message)

                # 发送回复
                wechat.send_text_message(user_id, reply)

            return 'success'

        except Exception as e:
            logger.error(f"处理消息失败: {e}", exc_info=True)
            return 'error', 500


if __name__ == '__main__':
    port = int(os.getenv('PORT', 8000))
    app.run(host='0.0.0.0', port=port, debug=False)
