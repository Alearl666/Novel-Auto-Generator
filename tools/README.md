# tools · 验证工具

这里放的是给开发/排查用的验证脚本。**装插件不需要它们**，删掉也不影响插件运行。
留着的作用是：以后改了代码，能在装进 SillyTavern 之前先跑一遍，提前发现白屏级别的问题。

需要 Node 20 以上。**不需要联网**，依赖的替身已经放在包根目录的 `node_modules/` 里了。

---

## 三个脚本

在包根目录下执行：

```bash
node tools/check-imports.mjs    # 最快，1 秒
node tools/smoke-boot.mjs       # 几秒
node tools/run-tests.mjs        # 十几秒
```

### check-imports.mjs · 导入图校验

扫描 `txtToWorldbook/` 下所有模块，检查每个 `import` 的文件真实存在、每个具名导入在目标模块确实有导出，并检测循环依赖。

**这是最值得先跑的一个。** ESM 里 import 一个不存在的导出会直接导致整个插件不加载，浏览器只给一句难懂的 SyntaxError，对着白屏很难查。这个脚本一秒就能定位到是哪个文件的哪一行。

期望输出：

```
扫描模块: 86 个
✅ 所有 import 均能解析，具名导出全部存在
✅ 无循环依赖
```

### smoke-boot.mjs · 启动冒烟测试

在 Node 里搭一个简易 DOM 替身，真的把插件启动一遍，然后打开主弹窗，确认关键界面元素存在、按钮都绑上了事件。

依赖注入链改动之后一定要跑这个——服务没注入、组装顺序不对、undefined 被当函数调用，都在这一步暴露。

期望输出：`启动冒烟测试：通过 26，失败 0`

### run-tests.mjs · 单元测试

跑 `tests/` 下的全部用例。期望输出：`总计：通过 311，失败 0`

只跑部分文件时可以传关键词跳过：

```bash
node tools/run-tests.mjs memoryHistoryDB    # 跳过文件名含该关键词的
```

---

## 关于 node_modules

包根目录的 `node_modules/` 里只有两个东西，都是我手写的替身，不是从 npm 装的：

- `vitest/` —— 极简兼容层，实现了测试文件实际用到的那部分 API（describe/it/expect/vi/fake timers）
- `fake-indexeddb/` —— 内存版 IndexedDB，让数据库测试能跑

原因是打包环境没有网络，装不了真的 vitest。如果你自己的电脑能联网，也可以直接：

```bash
npm install
npx vitest run
```

真 vitest 跑出来的结果应该一致。两者可以共存，`npm install` 会覆盖掉这两个替身目录。

---

## 建议的检查顺序

改完代码后按这个顺序，从快到慢，早失败早止损：

1. `node tools/check-imports.mjs` —— 挡住白屏
2. `node tools/smoke-boot.mjs` —— 挡住启动失败
3. `node tools/run-tests.mjs` —— 挡住逻辑回归
4. 装进 SillyTavern 实测

前三步全绿也不代表一定没问题——它们验证不了真实的网络行为，比如中转返回的 SSE 格式是否标准、模型对 max_tokens 的限制。那些只有第 4 步能发现。
