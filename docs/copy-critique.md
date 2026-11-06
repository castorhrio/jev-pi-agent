# 去 AI 味道：一次具名 critique，六处改动（中英各一条，共十二条 before / after）

> 日期：2026-11-06 ｜ 范围：`README.md` 中英两半 + 用户可见文案（`apps/desktop/src/shared/i18n.ts`）
> 这一页是**一轮的记录**，不是一条规则：它记的是这一轮判过哪些句子、为什么判、改成了什么。
> 下一轮再判时另起一节，不覆盖这一节。
> **第二轮（屏幕侧逐屏）**：`docs/copy-critique-screen.md`——判据不变，扫描方式从 grep 换成
> 逐屏逐条（第三刀之后是七屏四十七条），并且钉在字典上：改一个字，那一页就红。

## 为什么这一页存在

审查清单里「去 AI 味道」这一条挂了几轮，每一轮的写法都是同一句「没有新证据」。它挂住的原因不是
没人想改，而是**没有人把「像生成物」拆成可以指着屏幕说的形状**——于是它既不能被反驳，也不能被完成。

所以这一轮先做的是那个拆分：把「AI 味道」拆成五种**能在一句话里指出来**的形状，然后拿这五种形状
去扫两份东西——README 的中英两半，和屏幕上真的会出现的字（`i18n.ts` 的 665 条中文值 + 英文半）。
扫完的结果是：**屏幕上的文案是干净的，README 不干净**。六处改动（中英各一条，共十二条）全部落在
README，`i18n.ts` 一个字没动。

## 五种形状（判据，不是形容词）

| 形状 | 长什么样 | 为什么它读起来像生成物 |
|---|---|---|
| **缺口句** | 「X 补的就是这个缺口」 | 它先命名一个缺口，再声称补上，中间**没有说这个产品做了什么**。任何产品都能套这句话，所以它不携带信息。 |
| **格言句** | 「藏边界的工具比不藏的更不值得信任」 | 一句对任何产品都成立的话。它读起来像结论，实际是免责：读者点头，然后什么都没学到。 |
| **副词自夸** | 「如实读出它的连接状态」「Honest estimates」 | 形容词/副词在替事实说话。屏幕上有连接状态这件事本身是事实；「如实」是在要求读者相信，而不是给他看。 |
| **目录句** | 「下面逐项说明这两件事在界面上怎么核对」 | 一句关于**文档**的话，不是关于产品的话。读者已经在读了，不需要被告知接下来要读什么。 |
| **谜语计数** | 「五条在这里关掉；最后一条关不掉，它自己说了为什么」 | 把一条清单写成一个谜题，读者得先解码才知道有六条。清单的第一句应该就是清单。 |

## 屏幕侧：扫过，零命中（这一条也是结论）

`apps/desktop/src/shared/i18n.ts` 的 665 条中文值与英文半，按上面五种形状扫了一遍：

- 缺口句：`grep '缺口'` 命中 1 处，是 `stream.gapWarning` 的「事件流有 {count} 条缺口」——
  那是事件流里真的少了几条，不是「补上这个缺口」那种修辞。修辞用法 0 处。
- 格言句：`grep '值得信任\|如实\|诚实'` 命中 0 处。
- 副词自夸：`grep -i honest` 命中 2 处，都在注释里（一条说繁体中文没发布、简体是诚实的默认值；
  一条说英文半是人工校对过的），没有一处是屏幕上的字。`diag.env.*` 那一块（本机环境自检）
  写的是「每条给出命令和它打印的那一行」——给的是命令，不是形容词。
- 目录句：`grep '下面逐项\|接下来'` 命中 0 处。
- 谜语计数：0 处。三条阻塞在屏幕上就是三条，编号 1/2/3。

所以这一轮**没有改屏幕上的一个字**。这不是「屏幕已经完美」，而是「按这五条判据，屏幕没有命中」——
判据之外的东西（比如某句话是否够短、够具体）这一轮没有判，也不假装判过。

## 十二条改动（README 六处 × 中英两半，逐条 before / after）

### 1. 英文开头：缺口句

**before**

> UCAD closes that gap and makes both answers checkable: **which bytes did the agent receive**, and **why did it take that route**.

**after**

> UCAD puts both answers on screen: **which bytes did the agent receive**, and **why did it take that route**.

**为什么这读起来像真人**：它说的是这个产品**做了什么**（把两个答案放到屏幕上），而不是它**补上了谁的缺口**。
「closes that gap」的读者要回头找「that gap」指的是哪一段；「puts both answers on screen」的读者
可以直接抬头看屏幕。

### 2. 中文开头：同一句

**before**

> UCAD 补的就是这个缺口，并把两个问题的答案做成**可核对**的

**after**

> UCAD 把这两个答案都放到屏幕上

**为什么这读起来像真人**：中文这一句比英文更糟——「补的就是这个缺口」里的「就」是一个强调词，
强调的却是一个没有信息量的动作。改成「把这两个答案都放到屏幕上」之后，句子有一个主语、一个动作、
一个落点，三样都在屏幕上找得到。

### 3. 英文开头第二段：目录句（整段删除）

**before**

> The rest of this page shows how each of those checks works.

**after**

> （删除）

**为什么这读起来像真人**：真人写文档不会先告诉读者「接下来我要讲什么」——他直接讲。
这句话删掉之后，下一行就是 `### What it does`，读者一步没多走。

### 4. 中文开头第二段：同一句

**before**

> 下面逐项说明这两件事在界面上怎么核对。

**after**

> （删除）

**为什么这读起来像真人**：同上。中文这一句还多一层问题：它承诺「逐项说明」，而下面是一张
bullet 清单——承诺的形式和兑现的形式不一样，读者会觉得被糊了一下。

### 5. 英文 `Honest estimates` 小标题：副词自夸

**before**

> - **Honest estimates.** Token counts say whether they came from the vendor's tokenizer or from a heuristic, and say so on screen.

**after**

> - **Token counts that name their source.** A count says on screen whether it came from the vendor's tokenizer or from a heuristic.

**为什么这读起来像真人**：小标题现在说的是**屏幕上有什么**（一个标明出处的数），而不是
**这个产品有多诚实**。「honest」这个词在这里是自评，而自评是最容易被读者打折的一类词；
「name their source」是一个可以当场核对的动作。

### 6. 中文 `估算说实话` 小标题：同一处

**before**

> - **估算说实话。** token 数会标明来自厂商 tokenizer 还是启发式估算，并在界面上写明。

**after**

> - **token 数标明出处。** 屏幕上写着这个数来自厂商 tokenizer，还是启发式估算。

**为什么这读起来像真人**：「估算说实话」把一件产品行为写成了人品评价。改成「token 数标明出处」
之后，小标题和它下面那句说的是同一件事，而且第二句不再需要「并在界面上写明」这种补丁式从句——
「屏幕上写着」四个字就把位置说清了。

### 7. 英文 MCP 小标题：副词自夸

**before**

> - **MCP servers.** Configure a server, see its health honestly, remove it.

**after**

> - **MCP servers.** Add a server, see whether it connects, remove it.

**为什么这读起来像真人**：「see its health honestly」里的 honestly 在修饰一个读者根本看不见的动作。
「see whether it connects」是一个具体的问题，屏幕上有一个具体的答案（连上 / 没连上），
读者知道自己在看什么。

### 8. 中文 MCP 小标题：同一处

**before**

> - **MCP 服务器。** 添加一个、如实读出它的连接状态、随时移除。

**after**

> - **MCP 服务器。** 添加一个、看它连不连得上、随时移除。

**为什么这读起来像真人**：「如实读出」是三个字在替一个动作背书；「看它连不连得上」是那个动作本身。
另外三个动词（添加 / 看 / 移除）现在都是读者会做的动作，节奏也一致。

### 9. 英文「当前局限」开头：格言句

**before**

> Stated plainly: a tool that hides its edges is harder to trust than one that does not.

**after**

> Each gap below is one this repository knows about, with the command that shows it or the reason it cannot be closed here.

**为什么这读起来像真人**：原句是一句格言——它对任何工具都成立，所以它没有说这个仓库的任何事。
新句说的是这一节**怎么组织**：每条要么给一条能看见它的命令，要么说明为什么在这里关不掉。
读者读完这一句就知道下面六条 bullet 各自会长什么样，而这是格言给不了的。

### 10. 中文「当前局限」开头：同一句

**before**

> 直说，因为**藏边界的工具比不藏的更不值得信任**。

**after**

> 下面每一条都是本仓库知道的缺口：要么给出能看见它的命令，要么说明为什么在这里关不掉。

**为什么这读起来像真人**：中文原句还多一个「直说，因为」——它先声明自己要说实话，然后说一句
不需要说实话也能说的话。新句把「直说」这个动作换成了内容本身。

### 11. 英文「六条缺口」：谜语计数

**before**

> Six gaps sit in this repository. Five close here; the last one cannot, and says why.

**after**

> Six gaps are listed here. Five are things this repository has not done; the sixth is a property of the rendering engine, and no change here closes it.

**为什么这读起来像真人**：原句的「Five close here」是错的读法陷阱——那五条**没有**在这里关掉，
它们只是被写下来了。新句说的是实话：五条是没做的事，第六条是引擎的性质。读者不用解码就知道
六条 bullet 分成哪两类。

### 12. 中文「六条缺口」：同一句

**before**

> 六条缺口在本仓库里。五条在这里关掉；最后一条关不掉，它自己说了为什么。

**after**

> 下面六条。前五条是本仓库还没做的；第六条是渲染引擎的性质，改这里关不掉。

**为什么这读起来像真人**：「它自己说了为什么」把一条 bullet 拟人化了，读者得往下翻才知道
「它」是谁。新句直接说第六条是什么、为什么关不掉。

## 没有改的，以及为什么（这一半和改动一样重要）

- **`**Verifiable injection.**` / `**Explainable routing.**` 两个小标题**：它们是 DoD 的原句
  （`docs/PRODUCT-DOD.md` 的「可证明注入」「可解释路由」），改小标题会让 README 和 DoD 用两个词说
  同一件事。它们也不是上面五种形状里的任何一种——它们说的是这个产品做了什么。
- **`**A tray you can get out of.**`**：这句有点俏皮，但它俏皮在一个**具体的历史缺陷**上
  （托盘图标解不出来时应用会退出，而不是藏起来）。俏皮句只要指向一件真事，就不是 AI 味道。
- **`The failed-load screen deliberately has no .rail and no .statusbar` 那一段**：它是这一屏的
  判断与代价，`docs/dod-status.md` 有一整节论证它。删掉它等于删掉一个决定。
- **`docs/blockers.md`、`docs/dod-status.md` 的正文**：那两份是操作页与状态页，读者是接手的人，
  不是第一次打开仓库的人。它们的句子长，但每一句都在回答「敲什么 / 看到什么 / 改哪里」——
  按上面五条判据扫，零命中。
- **`i18n.ts` 一个字没动**：见上面「屏幕侧：扫过，零命中」。

## 门禁怎么保持绿（这一轮没有新增门禁）

这一轮**没有**新增任何门禁——审查的「明确不做」里写着不加新门禁，而这一页记的是判断，不是规则。
改动落在 README 上，所以既有门禁必须仍然绿，这一轮跑过的是：

```console
$ TMPDIR=$PWD/.run-logs/tmp npx vitest run tests/contract/readme-parity.test.ts \
    tests/contract/readme.test.ts tests/contract/typography.test.ts tests/contract/doc-citations.test.ts
 Test Files  4 passed (4)
      Tests  104 passed (104)
```

四条门禁各自管着这次改动的一面，值得写下来，因为下一次改 README 的人会撞上同一组：

- `readme-parity.test.ts`：中英两半的 `### 当前局限` 必须条数相同、每条带 `LIMITATIONS` 表里那组
  关键词。这一轮改的是**开头两句**，六条 bullet 一个字没动，所以它绿；改 bullet 的人会红。
- `readme.test.ts`：README 里点名的每个路径必须真的存在。这一轮没有增删路径。
- `typography.test.ts`：中英混排的空隙规则读的是 `i18n.ts`，不读 README；它绿是因为这一轮没动词典。
  它的 doc comment 里引用了被删掉的那句格言（「A tool that hides its edges…」），这一轮一并改成了
  指向新的开头句——一句注释引用一句已经不存在的原文，是这一页最不想留下的东西。
- `doc-citations.test.ts`：doc comment 里 `it('…')` 形式的引用必须指向真的存在的用例。这一轮没有
  新增或改名任何用例。

## 这一轮没有做的事

- **没有新增门禁**：这一页的五种形状是判据，不是断言。要把它变成断言，得先回答「一句话算不算
  格言」——那是一个会一直被改到不再尝试的规则，本仓对这类规则已经有过结论（`readme-parity.test.ts`
  的文件头写着同一句话）。所以它留在一页文档里，靠下一轮的人重读，而不是靠一条会红的测试。
- **没有改屏幕上的文案**：扫过，零命中，所以没有可改的。这不是「屏幕已经完美」。
- **没有碰 `docs/blockers.md` 与 `docs/dod-status.md` 的正文**：理由见上。
- **没有重拍截图**：这一轮没有改 `styles.css`、`App.tsx` 或 `i18n.ts`，渲染层源码哈希没变，
  `node scripts/screenshot-sources.mjs --check` 仍是
  `PASS — 34 renderer source(s) and 14 screenshot(s) match`。
