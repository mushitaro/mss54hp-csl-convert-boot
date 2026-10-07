# MSS54HP CSL converter 安全性レビュー（2026-10-06）

## 判定

**実機のブート置換・通常フラッシュを解錠できる段階とは判定しない。**
今回の変更は、コードから再現できた誤書込み・検証漏れを防ぐもの。
実 DME、K-line、電源、flash の実時間動作は試験していない。
`HARDWARE_WRITE_ENABLED = false` は変更していない。実機送信・デプロイも実施していない。

追加修正で `FAST_ENTRY_WRITE_ENABLED = false` に変更。元の24バイトをOBDで取得できない
サービス領域を、速度向上のために消去しない。実機は通常速度、PRACTICEは両経路を利用できる。

## 再現して修正した問題

| 重要度 | 問題と影響 | 修正 |
|---|---|---|
| P1 | ブート計画で、書込み前の verify、消去や電源再投入の欠落、誤った staging base / arming 表示を受理。未検証コードを arm できる | `blReplace.ts` で手順全体の順序、連続配置、実際の magic、SA0 CRC と表示値を再検証 |
| P1 | `runBlReplace` は予定した SA0 と staged SA0 の一致を調べず、read-before はログだけ | 消去前に予定値を照合。接続中 SA0 を二重読取りし、CRC と予定 SA0 との互換性を確認。置換では既知の M3/CSL 差分以外を許可しない |
| P1 | arm を含む最終チャンク全体が検証対象外。消去失敗を見逃し得る | 書込み待ちのバイトは `FF` と比較し、32 KiB 全域を arm 前に検証 |
| P1 | 最終書込みの ACK が失われると、実際には armed でも状態表示が false | 送信開始時点から「armed の可能性あり」と報告 |
| P1 | 電源再投入後に古い baud / access 状態を使用。replacement は magic 消去を確認しない | 9600 baud に戻し、受信側を整え再ログイン。probe / replacement とも対象 CPU の magic を実読して確認 |
| P1 | SP-DATEN の宣言チェックサム未検証、プログラムの欠落・重複・較正窓への誤配置を許可 | インポートで宣言 CRC 必須。生成時に両 CPU の全プログラム範囲の被覆と非重複、対応する 0401 の既知 CRC を再確認 |
| P1 | 較正の slave セクションが master 半分へ越境可能。破損較正を再計算で正当化し得る | 半分ごとの境界・重複検査。編集前と生成時に較正 CRC / padding を確認 |
| P1 | 通常フラッシュが元イメージと違う計画を受理し、通常較正経由でも loader magic を書ける | 実行前に全書込みバイトと元イメージを比較。通常経路では magic を禁止 |
| P1 | 検証済みの TypedArray を呼出側・callback が変更可能 | 計画、元イメージ、送信 payload を所有コピーに固定。通信ログ callback にも frame のコピーを渡す |
| P1 | hardware gate が宛先だけで許可。recycling key を write 宛先にした payload、窓越境・奇数番地・未知 segment が FAST ENTRY 許可で送信可能 | segment、payload 長、word alignment、region_table の全長受理を送信直前に確認 |
| P1 | FAST ENTRY が照合後の再読値を無検証で復元に使用。boot handoff vector を含む counter はバックアップとの同一性比較から除外 | counter を含む live block 全体を二度比較し、その同じ snapshot から復元データを作る。未知の prep marker は両 CPU の操作前に拒否 |
| P2 | 並行通信の拒否を retry が拾い、使用中の受信 buffer を drain し得る。read retry API で erase も反復可能 | 並行実行は即時拒否し resync しない。read retry で programming control 禁止、write retry は WRITE のみ |
| P1 | 読戻しが一致すれば、DME 自己検査が fault でも verified / 画面完了になる | fault が返れば verified=false。画面ではバイト差異と区別した理由で停止 |

## 追加修正で対応した残項目

1. **Finishと手動キー操作**: `flashExecute.ts` は種類ごとにFinishを送信してから検証する。
   全窓の二重読戻しと自己検査を通った場合だけ、TUNERと同じ
   **キーOFF → 10秒待機 → ON（エンジン停止）→ POWER CYCLED** を案内する。
   確認後に9600 baud・受信状態を復旧し、再IDENT・再ログイン・自己検査。
   `verified`（書込み内容の照合）と `completed`（キー操作後の確認済み）を分離した。
   Finish拒否、読戻し不一致、IDENT不応答、自己検査不応答・faultでは完了しない。
2. **消去順と相手CPUの較正**: TUNERは較正消去を `0xA02000` に1回だけ送り、両側を書いている。
   0401 masterの `0x2464` 以降も、program state `0x66` とdata state `0x3C` を分けて扱う。
   したがって以前の4窓連続消去は撤回し、種類ごとに「1回消去 → 両CPU書込み → Finish」とした。
   異なる種類の消去をFinishなしで開始する計画、相手側を含む重複消去、未完了のFinishを拒否。
   `PracticeDme` も両CPUの消去・モード遷移拒否をモデル化した。
   ブート段階は相手CPUの較正32 KiBを二重読取りし、消去で失われた場合に復元、二重照合してから
   対象CPUをstaging/armする。相手が既にarmed、読取り不一致、部分消去、復元不一致ならarmしない。
3. **ローダの実行時CRC**: `replace.s` は各SA0消去直前に staged SA0全16 KiBをCRC-16/ARCで検査する。
   CRCとその反転値はCPU `0xD000–0xD003`。ホストも計画検査・arm前読戻しで照合する。
   書込み後には実SA0のCRCを再計算。BMWのslave CRCが覆わない末尾も対象。
   エミュレータで本文・末尾・CRC・反転CRCの破損を注入し、disarmしてSA0を消さずに停止することを確認。
4. **FAST ENTRY**: censored bytesと消去途中の電源断はソフトウェアで復元できないため、実機では
   操作自体を施錠した。APIも消去前に通常速度へフォールバックし、低層の送信ゲートも拒否する。
5. **ACK喪失**: 低層の無条件WRITE再送を廃止。待機・受信復旧後に対象を2回読む。
   予定値と一致なら書込み済み、全域FFが2回確認できた場合だけ同一WRITEを再送（計3回まで）。
   部分書込み、不一致、読取り失敗、負ACK、検閲領域では再送しない。
   最終armの結果が不明な場合は、従来どおり「既にarmedの可能性」を明示する。

## 残存リスク・未確認事項

- program消去/書込み/Finishの実機受理、両CPUへの伝播、counter/AIFの実機での副作用・消費数。
  追加の `residentWorkflow.test.ts` で両CPUそれぞれの純正command handler、counter書込み、
  全Finish helperを実行し、変換経路を確認した。実UARTとCPU間schedulerは未再現。
  較正の対消去はTUNER実装からの根拠があるが、プログラムの対消去は同じ状態分岐からの推定を含む。
  `0x2EEA` はprogramの7セクタ、`0x2F8E` は較正セクタのローカル消去を行う。
  モデルは選択範囲への作用を検査するもので、実機の副作用を網羅した証明ではない。
- loaderのMCU初期状態、RAM、flash busy、watchdog、電源低下、SA0消去後の例外。
  RAMへVBRを移してもSA0消去後の例外から元データを復元できるわけではない。
- 書込み中のDS2読出しが応答すること、ACK喪失時の実flash状態。読出しが使えない個体では
  再送を止めることで安全側に倒すが、書込み完遂を保証しない。
- キーOFF/10秒/ONは人が実施してボタンで確認する。物理キー状態やエンジン始動成功を
  ソフトウェアが測定したことにはならない。IDENT応答はエンジン動作・車両適合性の証明ではない。

これらを「解決済み」として実機書込みロックを外さない。実機送信・電源操作は実施していない。

確認したローカル一次コード:

- `E46M3CSL_TuningTool/src/lib/dme-link/webSerialDmeLink.ts`: `writePartialBinInner` の
  較正消去、slave/master書込み、Finish (`07 0F 00 00 00 00`)、検証。
- `E46M3CSL_TuningTool/src/lib/dialog-text.ts`: `KEY_CYCLE_JA/EN` のOFF/10秒/ON。
- `E46M3CSL_TuningTool/src/app/page.tsx`: 成功時のキー操作案内と接続終了。
- ローカル0401 imageを `tools/analysis/disasm.py` で確認。master `0x2464–0x25EE` の
  書込みモード別分岐、`0x2EEA`/`0x2F8E` の消去範囲。program側の実機動作証明とは区別する。

## 検証と範囲

追加の `reviewSafety.test.ts` は、変更前に通ってしまった不正計画・破損入力と、ACK 喪失、
二重読取りの不一致、相手 CPU を巻き込む消去、callback による改変を注入する。
既存の純正 SP-DATEN、実車ダンプ、Community Patch、CPU32 / flash エミュレータのテストも実施した。
この段階の結果は **47ファイル・663テスト成功、スキップなし**。
その後、713件の検証段階からさらに通信のcount欠落、verify 8の誤受理、loader後の
モード遷移、中間Finishの問題を修正した。最終件数と実行証拠は下記の追加検証記録に集約する。
独立実装との照合、故障注入、ブラウザ試験、未証明の境界は
[PC上の追加検証結果](offline-verification-2026-10-06.md) に記録した。
`completionSafety.test.ts` とローダの異常系で、Finish失敗、キー操作待ち、再IDENT失敗、
自己検査不応答・fault、ACK喪失後の状態別処理、相手較正の復元、実行時CRC破損を確認した。
型チェック、web lint、本番ビルド、`git diff --check` も成功。実機操作・デプロイは未実施。

確認に使った外部一次資料:

- [NXP MC68376](https://www.nxp.com/products/MC68376?tab=Documentation_Tab): 4 KiB SRAM / 3.5 KiB TPURAM の製品仕様。
  これはモデルの構成の参考であり、接続された個体の MCU 同定・初期状態を証明するものではない。
- [Infineon NOR data polling](https://community.infineon.com/t5/Knowledge-Base-Articles/Data-polling-in-Infineon-Parallel-NOR-Flash/ta-p/443655):
  status polling の一般的説明。記事の例示品種は Am29F400B ではないため、本 DME のタイミング証明には使用していない。
