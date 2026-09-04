# CouncilBench-Large v0.1 — paired pilot

当前阶段：**准备与验证；等待人工审核题目及隐藏评分草案。没有真实性能结果。**

本模块不改变 Council 产品的默认行为。首批两题、四组、八份最终答案；H+D 与 H Alone 共用搜索证据，不是八次独立搜索。仅作流程与成本校准，不做显著性或普遍优越性结论。

## 方法与输入

| 组别 | 方法 | 最终作答模型 |
|---|---|---|
| S1 | 单次直接解决 | `opencode-go/deepseek-v4-pro` |
| S2 | 2–10 次互不见答案的独立搜索，再汇总 | DeepSeek V4 Pro |
| H+D | 当前四人两轮 Council 报告，再独立判断 | DeepSeek V4 Pro |
| H Alone | 同一 Council 报告，再独立判断 | `opencode-go/gpt-5.6-luna` |

Council 使用仓库配置中的 Muse 1.3、Qwen 3.8 Flash、GLM 5.3 Flash、HY4，以及 Luna。配置和代码随审核包冻结；现有全局用户配置不会被改写。首批不启用 Discovery 角色。H Alone 的最终作答在独立单模型会话中进行，不把产品协调器改成最终裁决者。

两组汇总接收逐字一致的题目、全文文件和报告。S1、S2 使用相同原始材料；每次独立搜索均创建全新会话。各组最终正文要求最多 600 英文词，仅作提示要求，不截断原答案、不伪称硬 token 限制。`run.json` 和私有调用记录保留原文与真实用量。

题目：

- `tasks/tenant-events/task.json`：合成多租户事件处理迁移及故障轨迹。要求分析方案，不是代码实现 benchmark。
- `tasks/paper-coordination/task.json`：三篇真实全文的机制/条件/实验辨析。参测模型仅可读取 `/task/papers/*.txt`；不能联网找额外材料。
- 对应 `rubric.json` 为**待审核草案，不是专家金标准**。Novelty 指相对所给问题和已列方案的非重复提议，不证明全世界首次发现。

### 论文来源

1. [Spanner: Google's Globally-Distributed Database](https://research.google.com/archive/spanner-osdi2012.pdf)，OSDI 2012。
2. [Calvin: Fast Distributed Transactions for Partitioned Database Systems](https://www.cs.umd.edu/~abadi/papers/calvin-sigmod12.pdf)，SIGMOD 2012。
3. [Coordination Avoidance in Database Systems](https://www.vldb.org/pvldb/vol8/p185-bailis.pdf)，PVLDB 2014。

固定原始 PDF 和 `pdftotext -layout` 提取文本的 SHA-256 存在 `tasks/paper-coordination/sources.json`。全文、PDF 和原始 Crossref 返回值在被忽略的 `papers/` 下，仅本地使用，不随项目再分发；公开全文不等于获得任意再分发许可。Crossref 用三个标题分别调用 `/works?query.bibliographic=...&rows=1`，完整端点和 raw JSON 位置均保留；检索结果只是元数据候选，题目来源以作者/会议全文为准。提取文本可能有双栏/表格顺序问题，审核者应对照 PDF；各组接收同一提取版本。

## 准备和审核（不调用模型）

依赖：Linux、可用的 bubblewrap 用户/PID namespace、OpenCode CLI、项目 Node 24.15.0、Python 3、Poppler `pdftotext`，以及项目 `npm ci` 依赖。benchmark SDK 单独固定在 `dependencies/`，不修改主机 Node 或主项目依赖。

```sh
npm ci --prefix benchmark/dependencies --ignore-scripts --no-audit --no-fund
python3 benchmark/fetch_papers.py
python3 -m unittest discover -s tests -p 'test_councilbench*.py'
sh scripts/verify.sh
python3 benchmark/engine.py prepare --output benchmark/local/pilot-review
python3 benchmark/engine.py validate --bundle benchmark/local/pilot-review
```

模型目录也作为公开元数据冻结在 `model-catalog.json`，与题目及执行代码一起计算 hash。它只包含 Go 目录，不包含认证或用户 provider 配置。隔离进程使用 `OPENCODE_MODELS_PATH` 指向该只读快照，并关闭后台模型刷新；每个 stage 在推理前运行实际 `opencode --pure models opencode-go`，核对所需六个 ID。预检计入 stage deadline，失败不会发起推理。需要更新目录时先显式生成新文件、审阅差异并重新冻结，不在运行时自动升级目录。

```sh
python3 benchmark/snapshot_models.py --source /path/to/public/models.json --output /path/to/new-model-catalog.json
```

该处理修复了首次隔离启动的冷缓存问题：内置目录可以早于后台刷新被采用，磁盘稍后出现新目录并不表示已开始的 provider 初始化使用了它。[OpenCode 1.18.25 模型目录加载源码](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/core/src/models-dev.ts)

首次获取固定来源，后续检测来源或提取 hash 改变时失败，不静默更新。`prepare` 冻结两题、全文文本、评分草案、方法及相关源码；目录已存在时拒绝覆盖。`REVIEW.md` 给出 manifest SHA。**必须先让用户审核，然后才可把该 SHA 作为 `run --approval` 的参数；不要自动把 prepare 输出串接 live run。** SHA 是明确选择的审核包身份，不是用户身份认证机制。

可以用 `run --mock` 在单独输出目录验证流程，结果显式标为 MOCK，绝不能写成真实性能结果。一个冻结包分别至多运行一次 mock 和一次 live；中断或失败不能换个输出目录偷偷重跑。源码/材料改动后必须新建包并重新审核。

## 审核通过后才执行

```sh
python3 benchmark/engine.py run --bundle benchmark/local/pilot-review \
  --approval REVIEWED_MANIFEST_SHA256 --output benchmark/local/pilot-live
```

每题顺序：共享 Council → H+D → H Alone → S1 → S2。固定顺序方便预算校准，但存在时间/服务负载混杂，不能用两题消除这一限制。

- Council 正常 8 次 participant dispatch，原有全局上限 12、两次纠错边界、600 秒 deadline 保留。单模型步骤至多 300 秒；benchmark 不做自动重试。
- S2 按 H+D 搜索＋最终答案的用量估计目标，预留相当于 H+D 最终作答的一次汇总预算，至少 2 次、最多 10 次独立搜索。首批4次上限明显欠量后才预注册提高上限；实际匹配落在 ±20% 才标记 matched，达到10次仍欠量则如实标 unmatched，不再补调用追数。
- 累计 gross observable 字段和达 500,000 或运行到 60 分钟，停止后续阶段。它们是调用间准入阈值，在途调用可能使累计值越界。未知用量立即停止后续调用；非零退出保留失败，不以成功样本替换。
- 每次 stage 只有显式输入文件可见；`bwrap` 不挂载题库、评分表、答案、宿主配置和仓库根。仅纯文本非隐藏路径可作为文件材料，避免 OpenCode 项目配置注入。没有可用隔离时直接失败，不退化成无沙箱。
- Go 认证在执行时从现有认证记录读取，只把 `opencode-go` 条目经匿名内存传给隔离进程。不会写回凭据、载入其他 provider/MCP 配置或向日志打印 token。文件只读/工具权限隔离不意味着凭据对 OpenCode 进程不可见——该进程仍需认证来调用 API。
- 新鲜隔离配置目录必须可写供 OpenCode 初始化；依赖为预装固定 SDK。关闭默认插件和项目配置发现；仅加载 Council 本地插件，不启动常驻服务。[OpenCode 配置开关](https://opencode.ai/docs/zh-cn/cli/)

## 计费与近似 compute

每个 assistant message 从隔离数据库按唯一消息 ID 读取一次，不能重复累计流式快照。input/output/reasoning/cache-read/cache-write 分项记录。gross 字段和仅是**保守的准入 charge**，字段可能重叠，不是收费 token。

匹配只使用每个响应均提供的正值 `tokens.total`，并进行基本一致性检查；没有该字段或值不可信时不推算“精确总量”。跨 provider 的 total 仍不是 FLOPs，也不保证财务口径一致；首批应进一步核对实际返回字段后决定是否可将 matched 用作研究证据。不能把 S2 表述成严格等算力。

H+D、H Alone 各自账面成本包含完整共享搜索。实际支出只累计一次共享调用；同时保留各组端到端构造耗时和整个配对执行耗时。

## 人工盲评与汇总

只交给评分者 `blinded/`、`annotations.template.json` 和隐藏评分表；不要给含 arm/model 的 `run.json` 或 `private/answer_map.json`。答案内部可能自报身份，不能声称绝对双盲。逐项填写布尔判断，并提供答案中的真实引用和 1-based 起止行；检查器只证明引用存在，不代替专家判定。

```sh
python3 benchmark/engine.py score --run benchmark/local/pilot-live \
  --annotations benchmark/local/reviewed-annotations.json --output benchmark/local/scored.json
python3 benchmark/engine.py summarize --scored benchmark/local/scored.json \
  --output benchmark/local/summary
```

KIR 为 Hit 数/预注册关键点数，Partial 单列且不进入分子；论文 PCIR 使用该题同一分母。重大遗漏率保守地将 Partial 和 Miss 都计入分子，并同时报告两者数量。TaskSuccess 由审核者按该题成功标准判定。MNY 分别标注 novel/grounded/testable，三者同时成立才入分子；同时报数量。候选必须记理由、反证和最低成本检验。无候选或无审计 claim 时相应比例为 NA，不是 0 或 100%。Unsupported Claim Rate 分母必须包含实际审计的 supported 和 unsupported factual claims；只列错误主张的表单不能估计该指标。`review_type` 明确区分 human 与 ai-assisted。

候选和 supported claim 使用公开材料 ID 作为 `source_refs`。候选讨论原文、call ID 和会话保留在本地用于少数意见贡献溯源；出现先后不能直接证明因果贡献。评分入口要求完整试验；不完整运行首先报告 `run.json` 的失败/停止和未执行情况，不用幸存答案的分数声称全部任务成功。

汇总生成逐题 TSV、Markdown 和 KIR–gross-token 散点及离散非支配前沿 SVG。两题不估计胜率置信区间、不做显著性检验、不把未观测点插值成性能曲线。

## 当前验收边界

故障诊断会分别保留推理前预检失败、进程退出/超时、Council 的持久化中止原因，以及独立的用量收集错误。字段缺失时保留 `known_observable_tokens`，但完整 gross 总量仍为未知并停止后续调用；不能把缺失量当作零。盲评索引显示预计/已有答案数量及完整性；评分入口除检查 complete 状态外，还要求每题四组恰好各一份，拒绝不完整或重复组别伪装成完整结果。

Participant 的 `completed` 只表示任务执行结束，不表示 JSON 有效；空白、纯文字和不完整 JSON 均先交 formatter，再按原 participant 身份进行最多两次格式纠错。重复校验同一已失败结果会中止，避免 coordinator 陷入无效循环。formatter 自身缺失、崩溃或超时属于执行环境故障，不能消耗模型纠错去修复。Council 产品仍保留12次dispatch、participant 5steps、两次纠错和8,000字符边界；为让单模型有机会读取三篇嵌套全文并保留最终作答步骤，benchmark 专用 `bench` agent 统一使用7steps。该差异属于方法定义并随审核包冻结。

本地 mock 和真实二进制的无网络配置加载/隔离测试可证明控制链路的部分性质，不能证明真实 provider 输出格式、用量完整性或复杂论文题的实际成功率。必须等用户审核后由首批 live 补足。所有本地运行目录、会话和讨论均忽略，不提交；本轮不进行 Git 推送或 npm 发布。
