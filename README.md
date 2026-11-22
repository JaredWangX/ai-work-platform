# AI 工作平台

把一个业务问题从提问带到交付。你可以在对话中选择数据源，让助手查数，下载可编辑的 Word、PowerPoint 或 Excel，也可以把相同的指令设为每天自动执行的任务。这是一个使用合成业务数据的交互式产品作品。

[打开公开工作台](https://ai-workspace-demo.wjrhsa.chatgpt.site/) · [体验数据库查询](https://ai-workspace-demo.wjrhsa.chatgpt.site/#database) · [查看自动化任务](https://ai-workspace-demo.wjrhsa.chatgpt.site/#tasks)

## 用一次门店复盘体验产品

1. 打开「数据库 → 渠道经营数据 → 查询数据」。默认查询按渠道汇总订单。把 SQL 换成下面这条，可以核对整个数据集。
2. 新建对话，在输入框下方选择「数据库 → 渠道经营数据」，输入「按渠道比较净销售额，为我生成 Excel 明细和两页 PPT」。文件会出现在对应回复和会话空间中。
3. 在「定时任务 → 新建任务」填写「查询订单总数和净销售额，生成 Excel」，选择同一个演示库，设置北京时间和频率，保存并启用。关闭页面后由服务器执行；回来打开该任务的「记录」，即可查看结果和下载文件。

~~~sql
SELECT COUNT(*) AS 订单数, SUM(amount - refund) AS 净销售额
FROM orders;
~~~

演示经营库有 63 笔订单，上面的查询实际返回净销售额 32,946 元。客服库另有 42 条工单，支持按问题分类、状态、处理时长分析。两套库均采用 2026 年 11 月 1–21 日的合成样本。查询在服务器上的只读 SQLite 连接执行。访客可以改 SQL；自填外部数据库地址只会保存成本地配置草稿。

## 功能与数据

| 产品入口 | 可以体验什么 | 数据位置 |
| --- | --- | --- |
| AI 对话与会话空间 | 模型流式回复、引用资料、按轮次预览文件、继续修改 | 当前浏览器；选中的参考内容会发送给模型 |
| 文件管理 | 读取上传的 Office 文本、按请求生成可编辑文件、下载案例资料 | 上传文件和对话产物留在当前浏览器 |
| 自动化任务 | 每天、工作日或每周一执行；支持暂停、运行记录和文件交付 | 计划与最近 8 次后台执行记录持久化在服务器 |
| 项目协作、员工与知识库 | 调整看板、助手说明、技能与参考笔记后用于对话 | 当前浏览器的工作空间 |

工作台里的预置案例可直接回放。预置任务需保存并启用才会注册后台计划。每个浏览器工作空间最多保存 8 个后台计划；清除站点数据会丢失访问这些计划的浏览器凭据。需要停止的任务请先暂停或删除。模型、渲染器与调度进程均依赖后端实例运行。

## 本地预览

使用 Node.js 22 或更高版本。在仓库根目录运行：

~~~sh
node server/build.mjs
node server/preview.mjs
~~~

打开 http://127.0.0.1:5091 即可查看前端、预置案例和已有示例附件。仅接入兼容模型时，可为预览进程设置服务端变量 MODEL_CHAT_URL 和 MODEL_API_KEY。当前默认模型标识为 qwen3.8-27b。

## 运行查询、调度和文件服务

完整部署由网页服务、Python 后台和模型端点组成。网页服务负责请求模型与校验文件结构，Python 后台执行查询、轮询到期任务并保存执行结果。定时运行复用对话的模型和文件生成代码。公共仓库自带基于 python-docx、python-pptx 和 openpyxl 的可编辑文件渲染器。

以下为单机开发环境示例。需要 Python 3.11+、Node.js 22+，以及提供相同模型标识的兼容推理服务。默认推理服务位于本机 8000 端口；可用 MODEL_ORIGIN 指定其他主机。以下操作从仓库根目录开始：

~~~sh
mkdir -p .runtime
python3 -m venv .runtime/venv
.runtime/venv/bin/pip install -r server/requirements.txt
(umask 077; openssl rand -hex 32 > .runtime/bridge-key)
~~~

将推理服务的 API 密钥保存到 .runtime/api-key。两个凭据文件均仅供服务端使用。在一个终端启动后台：

~~~sh
cd .runtime
export WORKSPACE_DATA="$PWD/data"
./venv/bin/uvicorn --app-dir ../server autodl_bridge:app --host 127.0.0.1 --port 6006
~~~

在另一个终端从仓库根目录启动网页服务：

~~~sh
export MODEL_BRIDGE_URL=http://127.0.0.1:6006/workspace-bridge
export MODEL_BRIDGE_KEY="$(cat .runtime/bridge-key)"
node server/build.mjs
node server/preview.mjs
~~~

后台首次启动会创建独立的订单库、工单库和任务记录库。恢复运行后，每项逾期任务补跑一次，再进入下一次计划。生产环境需为工作目录使用持久磁盘，并保持后台进程在线。

## 代码入口

- dist/app.js 包含工作台、会话、数据库与任务界面。dist/showcase.js 保存可回放案例。
- server/model.mjs 处理模型回复，server/office.mjs 和 server/office_render.py 负责文档生成。
- server/workspace.mjs 将自然语言问题转换为只读查询。server/workspace.py 管理实际数据库、查询限制、任务和文件归属。
- server/job-run.mjs 在调度触发时执行任务。server/build.mjs 将静态资产和服务端路由打包为可部署的 Worker。

~~~sh
node --test server/*.test.mjs
python3 -m unittest discover -s server -p 'test_*.py'
~~~
