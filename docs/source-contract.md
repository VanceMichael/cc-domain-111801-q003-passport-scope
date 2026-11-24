# PassportScope 来源约定

此服务管理用途许可领取、披露证据解释及可交付字段组装。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /passports/public`，返回 `purpose` 与 `passports`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `passport` 和 `purpose` 必须与目录一致。目录成员可通过 `relations` 显式声明字段披露关系的位置；未声明时不会猜测路径或扩大访问。

## 记录含义

```json
{
  "passport": "BP100",
  "purpose": "public",
  "manufacturer": "合成制造厂",
  "model": "CELL-A",
  "capacityWh": "120",
  "public": true
}
```

这里的字段是来源提供的原始声明，数值文本必须符合十进制规则，不能把空白或未知值转换成零。领域解释保留公开摘要边界、额定容量校验、护照与型号绑定。只有所选范围内且有充分常规依据的记录列入当前收件；其他范围、待确认、历史和冲突分别保留结果，不用覆盖旧原文消除分歧。

## 字段披露与用途许可

回收协作方接入后，维修与拆解人员看到的不是同一份资料。关联资料（示例位置 `/passports/public/relations/BP100`，由目录 `relations` 声明）按字段发布用途许可，结构为：

```json
{
  "passport": "BP100",
  "disclosures": [
    { "field": "chemistry", "purpose": "dismantle", "mode": "verify-only", "proof": "P1", "visible": true },
    { "field": "capacityWh", "purpose": "repair", "mode": "deliver", "proof": "P2", "visible": true },
    { "field": "partsList", "purpose": "dismantle", "mode": "deliver", "proof": "P3", "visible": true, "derivesFrom": ["chemistry"] },
    { "field": "supplierTrace", "purpose": "repair", "mode": "deliver", "proof": "P4", "visible": false }
  ],
  "requests": [
    { "field": "chemistry", "purpose": "repair", "status": "pending" }
  ],
  "proofs": [
    { "id": "P1", "mode": "verify-only", "href": "/passports/public/evidence/BP100/P1", "digest": "..." },
    { "id": "P2", "mode": "deliver", "href": "/passports/public/evidence/BP100/P2", "digest": "..." }
  ]
}
```

字段含义：

- `disclosures` 是字段级用途许可。同一字段可在不同用途下分别获批；同一用途下同一字段的披露不得重复。`mode` 必须与所引用 `proofs` 条目的模式一致。
- `mode: "deliver"` 表示字段内容可交付到该用途的当前采集包；`mode: "verify-only"` 表示证明只允许核验、不能交付，接收结果只保留核验结论与证明摘要，字段值不进入任何采集包。
- `visible: false` 表示来源已收缩/隐藏该字段许可。隐藏后当前可用包不得继续交付，但历史原文与收据作为“当时如何取得结果”的证据保留，不覆盖、不删除。
- `derivesFrom` 声明派生依赖。派生字段（如部件列表）只要任一来源字段在当前用途下失去可交付或可核验结论，派生内容一并撤出当前包；只隐藏最后一列不足以切断暴露。
- `requests` 记录在途授权申请。`pending` 表示申请尚未通过，进入“缺失授权依据”分区，既不能当成字段不存在，也不能伪造内容或写成核验失败。
- `proofs` 声明证明资料的位置、模式与可选摘要。`digest` 存在时，实际观察到的字节摘要必须与之相符，不符才构成核验失败。

## 接收结果的三个分区

按用途领取时，每个护照的结果明确区分：

1. **字段内容（`delivered`）**：当前用途已获批 `deliver` 的字段，含字段值与证明摘要，构成当前可用包。
2. **仅核验结论（`verifications`）**：`verify-only` 的成功核验结论，以及摘要不符的 `verification-failed`。前者不含字段值，后者阻断完成宣告。
3. **缺失授权依据（`missingBasis`）**：`pending-grant`（待批）、`grant-withdrawn`（已隐藏）、`proof-unavailable`（证明暂时取不到）、`withheld-derived`（派生连带撤出）。

证明暂时取不到（HTTP 403/404/503、超时等）统一记为 `proof-unavailable` 并标记 `temporary`，不自行解释为业务删除，也不写成核验失败；只有实际摘要与来源声明不符才是 `verification-failed`。

## 用途隔离与复用

- 字段收据以 `(用途, 护照, 字段)` 独立落库。同一内容摘要在维修与拆解许可下分别取得时，各自保存用途收据、共享同一份内容寻址原文，互不污染。
- 用途变更或许可收缩只影响该用途下的领取、复用与当前交付；其他用途合法取得的资料不受误伤。
- 当前可用包对每个 `(用途, 护照, 字段)` 只取最新一次结论，并剔除所有非 `delivered` 字段；历史收据仍可逐笔复查。
- 整个流程只请求来源目录与披露关系中显式声明、且当前用途可见的证明资源，不猜测未声明路径、不尝试扩大访问范围。

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。测试在进程内操作夹具，不提供对外开放的管理接口。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。公开摘要收据存入 `receipts`，字段级用途收据存入只追加的 `field_receipts`（含披露关系摘要、证明摘要与逐字段决策）。收到原文不等于领域接收成功；重复的同一内容不新增原文，同一身份的不同内容不会覆盖原件，verify-only 原文仅作为证据保管、不进入交付通道。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。
