# URDF 可视化功能在线系统

按《urdf可视化功能在线系统 需求文档(prd-v0.1).md》实现，当前为 **阶段 1-1：本地网页版**。

## 已实现（1-1）

- **登录页**：邀请码注册（邀请码由管理员在后台生成）、用户名+密码+确认密码、3 小时无操作自动登出
- **主功能页**
  - 区域 1：左手/右手 .urdf 导入；关节节点 2D 连接图（节点数随自由度自动调整、单击节点显示 joint/link 全称、主动自由度带 `m` 标记、命名不在标准表内标红）；顶部自由度统计（总计/主动/被动）；左右手切换
  - 区域 2：左右手镜像 —— **UI 占位**，1-2 阶段集成 `urdf_mirror.py`
  - 区域 3：分类检查 —— **UI 占位**，1-2 阶段集成 `urdf_parser_checker.py`
  - 区域 4：点击 joint 节点显示运动学/动力学参数表；「确认修改」做数据类型校验（错误标红并禁止导出）；「导出 URDF」带进度条，同时同步更新服务器端当前文件
- **管理统计页**（仅管理员/超管可见）
  - 分区 1：按年/月/日查询使用人数与各功能使用次数
  - 分区 2：用户查询、设置/取消管理员、拉黑/恢复、邀请码生成
  - 分区 3：按用户名禁止登录、「禁止全员访问」（超管除外）、上传标准命名表 `standard_urdf_name.xlsx`
- **角色权限**：超级管理员（首个账号 admin，永久权限不可降权/禁用）＞ 管理员 ＞ 普通用户

## 技术栈（按 PRD）

- 前端：Vue 3（无构建轻量化版 `static/vendor/vue.global.prod.js`，免打包）
- 后端：FastAPI + SQLAlchemy
- 数据库：本地 SQLite（`data/app.db`）；上阿里云时设置环境变量切换到 MySQL：
  `DATABASE_URL=mysql+pymysql://user:pass@host:3306/urdf_web?charset=utf8mb4`

## 运行

```bash
pip install -r requirements.txt
python main.py            # 打开 http://localhost:8000
# 或 npm run dev          # 端口 7100（Kimi Work 预览走这个）
```

首次启动创建超级管理员 `admin / admin123`，请登录后尽快修改密码。

## 目录结构

```
main.py               FastAPI 后端（认证/URDF/统计/权限/邀请码）
db.py / models.py     SQLAlchemy 连接层与数据模型
static/               Vue 前端（index.html + js/app.js + js/urdf-tools.js）
static/vendor/        本地化 Vue；three.js+urdf-loader 备用（后续 3D 显示）
examples/             示例 URDF
tools/e2e_test.py     Playwright 端到端回归验证脚本
data/                 运行时生成：app.db、workspace/<用户>/、standard_urdf_name.xlsx
```

## 标准命名表

把 `standard_urdf_name.xlsx` 放到 `data/` 目录，或在管理统计页分区 3 上传。表内所有单元格文本都会被视为合法 joint/link 名称；未配置时区域 1 不做标红并提示。

## 下一阶段（1-2）

拿到 `urdf_mirror.py` / `urdf_parser_checker.py` 后集成区域 2、3：后端调用脚本、前端遮罩/进度条/结果下拉框，并补记 `mirror_run` / `check_run` 使用统计。
