# PassportScope 来源约定

此服务管理用途许可领取、披露证据解释及可交付字段组装。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /passports/public`，返回 `purpose` 与 `passports`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `passport` 和 `purpose` 必须与目录一致。

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

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。同一来源也可发布关联资料，当前示例的关联资料位置为 `/passports/public/relations/BP100`，字段保留来源的业务含义：

```json
{
  "disclosures": [
    {
      "field": "chemistry",
      "purpose": "dismantle",
      "proof": "P1"
    }
  ],
  "proofs": [
    {
      "id": "P1",
      "mode": "verify-only"
    }
  ]
}
```

`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。测试在进程内操作夹具，不提供对外开放的管理接口。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 字段级披露

公开摘要之外，来源可按用途发布字段级披露。目录成员可声明 `relations`（关联资料位置）与 `purposes`（该来源已授予的用途）。关联资料的 `disclosures` 说明某用途可取得哪些字段、依据哪个 `proof`，`proofs` 说明证明的模式：

```json
{
  "passport": "BP100",
  "disclosures": [
    {"field": "chemistry", "purpose": "repair", "proof": "P1"},
    {"field": "capacityWh", "purpose": "repair", "proof": "P2"},
    {"field": "parts", "purpose": "repair", "proof": "P2", "derivedFrom": ["chemistry"]},
    {"field": "serial", "purpose": "repair", "proof": "P3", "approved": false}
  ],
  "proofs": [
    {"id": "P1", "mode": "verify-only", "conclusion": {"verified": true, "chemistry": "LFP"}},
    {"id": "P2", "mode": "content", "dependsOn": ["P4"]},
    {"id": "P3", "mode": "content"},
    {"id": "P4", "mode": "verify-only", "conclusion": {"verified": true, "basis": "registry"}}
  ]
}
```

`content` 模式可交付字段原文，`verify-only` 只允许核验并给出结论。字段值放在原文的 `fields` 中；接收结果按用途分别返回：

- `content`：该用途本次可交付的字段内容。
- `conclusions`：由仅核验证明得出的字段结论，不含原始内容；`proofConclusions` 记录依赖链上的仅核验证明结论。
- `pending`：仍缺少授权依据或证明的字段，`reason` 说明是 `authorization-pending`（新申请尚未通过）还是 `proof-unavailable` / `proof-basis-unavailable`（证明暂时不可取）。这些字段不是“不存在”，也不写成核验失败。
- `withheld`：已失去交付许可的字段。`hidden`（来源隐藏）、`revoked`（许可收缩）、`no-longer-disclosed`（该用途不再披露）以及 `derived-from-…`（派生来源不可交付）都会使字段退出当前包。
- `evidence`：每个字段当时的证明、模式与处理结果，作为复查依据。

`derivedFrom` 的字段只有在全部来源字段都可作为内容交付时才可交付；仅核验的来源字段只贡献结论，不会让派生结果带出原文。同一内容摘要可以在不同用途下分别取得，各用途的当前交付相互独立。

## 用途变更与许可收缩

当前交付按用途单独保存（`Archive.deliver` / `currentDelivery` / `retract`），历史收据按原文与关联声明的内容摘要保留（`putPackage` / `packages`）。`receive` 按用途领取；`refresh` 用途变更或许可收缩后重新形成当前交付。收缩时只撤销受影响用途中不再获许可的字段，其他用途的合法交付不受影响；旧原文与旧收据不删除，可继续复查当时如何取得结果。只删除最后一列不够：派生字段会因其来源字段不可交付而一并退出当前包。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。收到原文不等于领域接收成功；重复的同一内容不新增收据，同一身份的不同内容不会覆盖原件。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。
