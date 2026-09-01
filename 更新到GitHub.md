# 更新到 GitHub · v4.0.1

传到自己的 GitHub 仓库之后，SillyTavern 就能用仓库地址直接安装和更新，比手动拷文件方便得多。

三种方式，按你手上有什么工具选。**电脑上强烈推荐方式一或方式二**，手机单独看最后一节。

---

## 先记住一件事（最容易翻车的地方）

**上传新文件不会删掉旧文件。**

你旧仓库根目录有个 `txtToWorldbook.js`（那个 11937 行的单文件版）。新版已经把它拆成 `txtToWorldbook/` 文件夹了。如果只上传不删除，仓库里会同时存在：

```
txtToWorldbook.js        ← 旧的单文件，必须删
txtToWorldbook/          ← 新的文件夹
```

两个同时在，`index.js` 加载的是文件夹版，单文件不会被执行，但它会一直躺在仓库里让你以后犯迷糊。

**需要删除的文件只有这一个：根目录的 `txtToWorldbook.js`。** 其他所有文件要么被覆盖，要么是新增的。

---

## 方式一：GitHub 网页上传（不用装任何东西）

只能在**电脑浏览器**上做，手机浏览器传不了文件夹。

**第 1 步 · 先删旧文件**

1. 打开你的仓库页面
2. 点进根目录的 `txtToWorldbook.js`
3. 右上角垃圾桶图标 → `Commit changes`

**第 2 步 · 上传新文件**

1. 回到仓库首页，点 `Add file` → `Upload files`
2. 把解压出来的 **`Novel-Auto-Generator-v4.0.1` 文件夹里的所有内容**拖进去
   - 注意是文件夹**里面**的东西，不是文件夹本身
   - 全选：`index.js`、`manifest.json`、`style.css`、`epubToTxt.js`、`worldbookExport.js`、`txtToWorldbook` 文件夹、`tests`、`tools`、以及那些配置文件
3. 下面的提交信息填 `更新到 v4.0.1`
4. 点 `Commit changes`

传 127 个文件会慢一点，等它转完。

**第 3 步 · 核对**

刷新仓库首页，确认：

- `txtToWorldbook` 是个**文件夹**（点进去有 88 个文件），不是 `.js` 文件
- 根目录已经没有 `txtToWorldbook.js`
- `manifest.json` 里的 version 是 `4.0.1`

---

## 方式二：GitHub Desktop（图形界面，适合以后经常改）

装一次，之后每次更新都是三下点击。

1. 装 [GitHub Desktop](https://desktop.github.com)，登录你的账号
2. `File` → `Clone repository`，选你的仓库，克隆到本地
3. 打开克隆下来的文件夹，**把里面的东西全部删掉**（除了隐藏的 `.git` 文件夹，那个千万别删）
4. 把解压出来的 `Novel-Auto-Generator-v4.0.1` 文件夹里的所有内容复制进去
5. 回到 GitHub Desktop，左边会列出所有改动（包括被删掉的 `txtToWorldbook.js`）
6. 左下角填提交信息 `更新到 v4.0.1`，点 `Commit to main`
7. 右上角 `Push origin`

第 3 步的"全部删掉再放新的"是关键——这样被移除的文件会被 git 自动识别成删除，不用手动去删。

---

## 方式三：命令行

```bash
git clone https://github.com/你的用户名/你的仓库名.git
cd 你的仓库名

# 清空（保留 .git）
find . -maxdepth 1 ! -name . ! -name .git -exec rm -rf {} +

# 把新版内容复制进来
cp -r /解压路径/Novel-Auto-Generator-v4.0.1/. .

git add -A
git commit -m "更新到 v4.0.1"
git push
```

`git add -A` 会同时记录新增、修改和删除，所以 `txtToWorldbook.js` 的删除会自动包含进去。

---

## 传完之后：在 SillyTavern 里安装

1. 扩展面板 → `Install extension`
2. 填仓库地址：`https://github.com/你的用户名/你的仓库名`
3. 装完重启 SillyTavern，浏览器 `Ctrl + F5`

**如果之前已经装过旧版**，先在扩展列表里把旧的删掉再装，或者点它的更新按钮。直接装可能因为目录已存在而失败。

以后再更新，就只需要在扩展面板点一下更新按钮，不用再手动拷文件了——这是传 GitHub 最大的好处。

---

## 手机怎么办

手机浏览器传不了文件夹，网页上传这条路走不通。三个替代方案：

**A. 借电脑传一次（最省事）**
传上去之后，手机端就只需要在 SillyTavern 里点更新按钮，以后都不用再碰电脑。

**B. 用手机版 Git 客户端**
安卓上装 MGit 或 Termux。Termux 里就是方式三那套命令，但要先 `pkg install git` 并配置好访问令牌，对不写代码的人来说门槛不低。

**C. 跳过 GitHub，直接拷文件**
就按 `安装说明.md` 里的手机方式装。功能完全一样，只是以后每次更新都得手动拷一遍。

如果你更新不频繁，C 其实完全够用。GitHub 的价值在于"以后点一下就更新"，值不值得折腾看你自己。

---

## 两个可能让你困惑的点

**仓库页面可能出现红色 ❌**

仓库里带了个 `.github/workflows/ci.yml`，每次推送会自动跑代码风格检查（ESLint + Prettier）。我写的新代码是手敲的，没跑过 Prettier 格式化，很可能过不了那个检查，于是提交旁边会显示一个红叉。

**这不影响插件运行**，纯粹是代码排版规范的检查。三个选择：

- 不管它，红叉纯属好看不好看的问题
- 把 `.github` 整个文件夹删掉，从此不再检查（个人仓库这么做很常见）
- 以后在能联网的电脑上跑 `npm install && npm run format` 自动格式化，就绿了

**`node_modules` 文件夹**

正常情况下这个文件夹不该进仓库，但我在 `.gitignore` 里开了两个例外：`vitest/` 和 `fake-indexeddb/`。这两个是我手写的测试替身（打包环境没网络，装不了真的），不跟着仓库走的话，`tools/` 里的测试脚本克隆下来就跑不了。

它们加起来不到 30KB，留着无害。
