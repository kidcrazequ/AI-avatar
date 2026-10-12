# 通用角色头像

2026-10-11 按用户最新确认的黑白简笔人物与浅色圆底方向，重新设计的 11 个通用角色头像。

使用内置 image_gen，按各角色独立文字设定生成人物，没有把第三方头像截图或贴原图重绘的样稿作为生成输入。
当前构图源图和完整编辑请求保存在 evidence/qoderwake-cn-avatar-close-framing/originals/ 与 prompts.json；首次独立人物创作记录保存在 evidence/qoderwake-cn-original-line-avatars/。
同名 PNG 为源图等比例缩小的 480 × 480 版本，同时写入 expert-packs/<id>/avatar.png；组件负责圆形裁切。
统一黑白人物线描和低饱和圆形底色，脸型、发型、表情、衣领及佩饰分别设计；辨识度不只依靠颜色。
24/32/48px 并排视图见 evidence/qoderwake-cn-avatar-close-framing/contact-sheet.png，角色特征见 design-recipes.json。
上一版摄影头像归档在 evidence/qoderwake-cn-original-line-avatars/superseded-photos/，更早的探索图保留在各自证据目录，不作为当前资产。
根据大小与角色对应的反馈，前端、产品经理、UI 设计师、项目管理员重新绘制，上一稿保存在 superseded-line-v1/ 与 prompts-line-v1.json。
用户随后指出身子显示过多：用现有 11 张原创人物作编辑输入，保留人物与画法，构图改成头部为主，仅露少量肩膀和衣领；没有输入第三方参考头像。创建页和详情页外框仍为 72px。
素材来源及法律边界见 evidence/qoderwake-cn-avatar-close-framing/PROVENANCE.md；独立生成不等于已经完成在先作品清查或保证不侵权。

旧内置头像的字节指纹保存在 shared/legacy-role-avatars.ts；显示更新不重写运行时专家文件。
上传头像和导入专家包的头像继续归各自专家所有。小堵及自定义角色的头像保持原设置。
role-placeholder.png 为自定义专家的现有占位资源，未纳入本轮人像替换。
