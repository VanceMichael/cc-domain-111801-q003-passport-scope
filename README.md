# PassportScope

PassportScope 为业务资料员提供用途许可领取与原文保管，已支持来源目录预览、直接记录领取、公开摘要边界、额定容量校验、护照与型号绑定以及按业务范围形成收件记录。回收协作方接入后，进一步支持按已获批用途（如维修、拆解）接收字段级资料：字段内容、仅核验结论与缺失授权依据分区呈现，verify-only 证明不交付原文，许可收缩后当前包与派生字段同步撤出而历史证据保留。原文与领域收件结论分开保存，便于复查来源内容。

## 环境与运行

使用 Node.js 22.23.4，依赖版本由 `package-lock.json` 固定。仅使用 Node.js 内置模块，无需外部数据库进程或第三方运行服务。

```sh
npm ci
npm run build
npm test
npm run demo
```

`npm run demo` 在本机启动合作源，用独立临时目录完成真实领取、原文保存和领域接收，输出实际结果后清理；不要求外网资料。`npm start` 可单独启动本地来源供交互查看，终端会打印实际回环地址，Ctrl-C 关闭。通过 `PORT` 指定监听端口，省略或设置为 `0` 时自动分配；仅监听回环地址。根路径返回可用资源目录与运行状态。

## 容器

```sh
docker build -t passport-scope:local .
docker run --rm --network none passport-scope:local
```

镜像构建时准备依赖，容器运行时不联网，演示只使用回环通信。可改用 `docker run --rm --network none passport-scope:local npm test` 运行回归。存储通过 `Archive` 传入本机目录，不包含生产账号、真实业务资料或凭据。

## 代码与来源约定

`src/source.mjs` 负责来源目录、原文与披露关系身份，`src/interpret.mjs` 解释当前领域记录，`src/disclosures.mjs` 解释字段披露并给出字段级处置结论，`src/receiving.mjs` 决定公开摘要范围内的收件结果，`src/app.mjs` 连接日常业务与按用途领取，`src/archive.mjs` 提供原文保管、公开收据与只追加的字段级收据。`fixtures/` 与 `src/fixture-source.mjs` 提供可独立复查的本地合作源。详细字段、用途许可与来源声明见 `docs/source-contract.md`。
