# 多图队列上传与模型比例 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复多图队列的批量拖拽、原图上传、自动出图比例、提示词批量同步和置顶状态一致性，并验证 HK 模型请求链路。

**Architecture:** 保留现有 `queueData` 与图片槽结构，将批量文件按拖入顺序稳定映射到连续槽位；上传模式由全局模型配置驱动，`original` 模式同时跳过前端裁剪和后端缩放。置顶图片继续使用根级 `pinnedSlotIndices`/`pinnedSlotMasters` 作为单一状态源，并兼容合并旧队列数据。

**Tech Stack:** Flask、原生 JavaScript、HTML、Pillow、pytest/Flask test client、浏览器交互测试。

---

### Task 1: 原图上传模式

**Files:**
- Modify: `templates/index.html`
- Modify: `static/js/app.js`
- Modify: `app.py`
- Modify: `data/model_config.json`
- Modify: `default_data/model_config.json`

**Steps:**
1. 在设置中加入“自适应裁剪压缩 / 不裁剪（原始尺寸）”选项。
2. 读取并保存 `upload_mode` 配置。
3. 批量拖入时按 FileList 顺序连续落位；原图模式不打开逐张裁剪弹窗。
4. 后端原图模式保持像素尺寸，不执行档位缩放。
5. 用不同宽高的测试图片验证上传前后像素尺寸。

### Task 2: 自动出图比例

**Files:**
- Modify: `static/js/app.js`
- Modify: `templates/index.html`

**Steps:**
1. 给支持自动比例的 RH、Nano Banana 和 GPT 图片模型加入 `auto`。
2. 从首张有效参考图读取宽高比；没有参考图时使用模型的自动值或安全默认值。
3. HK Nano 请求使用 `aspect_ratio=auto`，GPT 请求使用 `size=auto`，避免把 `auto` 误算成正方形。
4. 验证单队列与批量队列请求载荷。

### Task 3: 一键同步提示词

**Files:**
- Modify: `templates/index.html`
- Modify: `static/js/app.js`

**Steps:**
1. 多图队列模式显示“应用全部队列”按钮。
2. 点击后同步中英文提示词到 10 个队列并立即持久化。
3. 切换各队列确认文本一致。

### Task 4: 置顶状态一致性

**Files:**
- Modify: `static/js/app.js`

**Steps:**
1. 恢复数据时合并根级和旧版每队列置顶索引。
2. 以根级主图片覆盖所有队列对应槽，并同步每队列高亮索引。
3. 对置顶、取消、拖动换位和重载做回归验证。

### Task 5: HK/RH 链路与发图实测

**Files:**
- Test: `app.py` Flask 路由
- Test: `static/js/app.js` 请求构造逻辑
- Inspect: `logs/app.log`

**Steps:**
1. 做 Python/JavaScript 语法检查与后端单元测试。
2. 启动本地服务，做浏览器拖拽、排序、同步和高亮验证。
3. 使用已配置的 HK 凭据提交一张普通测试图，记录实际 HTTP 状态、任务 ID、返图尺寸和上游返回字段。
4. 根据 endpoint/model/payload 与响应证据判断链路是否正确；视觉差异只作为现象，不作为“模型掺水”的证据。
