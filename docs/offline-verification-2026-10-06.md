# PC上の追加検証（2026-10-06）

## 2026-10-07 Android縦向きPWAのレイアウト修正

`tsunagi-m-design`、`tsunagi-m-mobile`（layout/touchを含む）、stack/releaseのSkillを確認。
PWAの縦向きでハブ周辺が見切れるというユーザー報告に対し、Chromiumで修正前後を測定した。

- 320×568のbackup画面では補助ボタンの下端が590.5px（22.5px画面外）、360×640では647.5pxだった。
  ハブ下を戻る/切断中心の2操作に絞り、再取得・ログ保存・UPLOADは説明領域へ移した。
  ハンドラーと実行条件は維持し、ログ保存のダウンロードも実際に操作して確認した。
- 操作領域に198pxの床（通知64＋ハブ帯88＋補助操作46）を設定。ハブ72px、補助操作44px以上。
  修正後の最下端は320×568で567px、360×640で639px。短い画面は説明領域が先に縮む。
- `100svh` に統一し、safe-area paddingのない `viewport-fit=cover` を外した。
  通知の2行打切りを廃止し、長文は固定枠内で最後までスクロールできる。
  次の工程では説明領域を先頭に戻し、前画面のログ位置に警告が隠れないようにした。
- 320×568、360×640、360×800、430×920、851×393、683×400、1440×900の7寸法・56状態を検査。
  ハブと補助操作の画面内配置、ログ保存、次画面の先頭表示、キー操作待ち、長文通知の末尾への到達が成功。
  1440×900の操作領域高は315.5pxを維持。ハブはSkillの72pxへ変更、通知拡張に伴い中心は15px下がる。
  Android実機のPWAを直接操作した試験ではなく、対応CSS viewportとタッチ設定のChromium試験。
- 全56ファイル・765テスト成功（skipなし）、typecheck/lint/build成功。
  PD3J＋CP v1の全変換ブラウザー試験も完了。実機書込みロックは維持。

記録は `data/verification/mobile-layout/{before,after}.json` と画像、`mobile-suite.json`、
`mobile-flow.log`、`mobile-{typecheck,lint,build}.log`。
再実行: `python tools/analysis/mobile_layout_verify.py`（ローカルdevサーバ5173を起動）。

今回の修正は未配信。Cloudflare deployment一覧の照会は認証エラー10000、配信URLの未認証取得は401で、
配信中のbuild-idは確認できなかった。これらを配信成功とは扱わない。

## 結果と適用範囲

予備DMEなし・PCのみというユーザー指定で、下記の検証を完了した。
**最終Vitestは56ファイル・765件成功、失敗・スキップなし（71.55秒）。**
今回の検証作業では実DME、USBケーブル、電源への操作、デプロイは行っていない。
ユーザーによる過去の実車接続経験はある。接続経験がないという意味ではない。
`HARDWARE_WRITE_ENABLED` と `FAST_ENTRY_WRITE_ENABLED` は false のまま。
これは実機安全認定や、ブリックの可能性がゼロになったという判定ではない。

以前の713件成功の時点では、純正ファームウェアのWRITE受付、中間Finish、
loader後のモード遷移が十分検証されていなかった。今回は実バイナリからその処理を実行し、
見つかった不具合を修正した。Practice完走を実機動作の証明に代用していない。

## 修正した重要な問題

### WRITEの長さバイト欠落

通常WRITEとFAST ENTRY用WRITEが `07 02 address[3] data` になっていた。
純正command parserとTUNER/DS2Toolを照合し、正しい
`07 02 address[3] count data` に修正。低層送信でもcountと実データ長の一致を確認する。
Practiceの同じ誤りも修正し、ホスト生成の2/16/122バイトWRITEを純正ROMに渡して
NORモデルへの書込みを確認した。全32 KiB較正・全256 KiB programも実行した。

### control応答のverify 8を成功扱いしていた

純正ROMでは較正モード3Cからprogram消去を要求すると、外側ACK＋verify 8を返し、
flashを変更しない。旧判定ではこれを成功扱いしていた。
現在は詳細応答の長さ・segment・アドレスecho・countゼロ・verifyを確認する。
通常消去と最終Finishはverify 1必須。bare ACKは既存参照プロトコルとの互換性を維持する。
Recycleのverifyは参照仕様どおりadvisoryだが、形状検査は行う。

### loader後のモード遷移

純正較正消去はAIF counterに00FFを記録する。キーOFF/ONしてもこのモードは残り、
従来のreplacement loaderではmasterがprogram消去を拒否する。

現行loaderはmasterについて、SA0を消す前にcounter全128バイトの正規形・00FF・容量を確認する。
使用済み55ワード以下、残り全てFFFFだけを受理する。SA0全域の書込み・比較・CRC成功後に限り、
次の1ワードにFF00を書いて照合し、前の00FFを000F→0000の2段階で消し、それぞれ照合する。
SA1消去、VIN/AIF履歴の移植、履歴の推測修復は行わない。

新markerを先に作るため、通常の完了順序で全ワードがゼロだけになる中間状態を作らない。
旧markerの2段階クリアは、単調な1→0部分書込みから特殊起動marker 00F5が生成されることを避ける。
そのような部分値を全列挙した。ただし実NORの低電圧挙動の保証ではない。
失敗後の非正規counterはホストが拒否し、自動修復・再消去へ進まない。
slaveは較正モードを保ち、次の純正program消去のslave分岐がprogramモードへ移す。

ホストも開始前に両CPUのcounterを2回読み、正規形・一致・容量・masterの開始モードを確認する。
最低余裕はprogram 8ワード、通常モードから較正10、既存の較正モードから9。
master置換後にはprogramモードを再読取りして確認する。

### 中間Finishと最終Finishの区別

program書込み後も較正領域にloaderが残るため、純正master Finishはverify 15を返し、
状態66→C3→3Cとなる。全metadata helper・counter writerを実行して確認した。

program＋calibration計画の中間Finishだけverify 15を許容し、両CPUのprogram全域を
2回読み戻して予定データと一致した場合だけcalibration消去へ進む。
どちらかのCPU・どちらかのpassで不一致なら次の消去を出さない。
最終Finishはverify 1必須。その後の二重full backup、自己検査、利用者によるキーOFF/10秒/ON、
再IDENT・再ログイン・再自己検査が揃って初めて完了にする。自動resetで代用しない。

### 検証モデルとUI

CPUのADD/ASL overflow、MOVEM、index付き実効アドレスのscale/PC基準/full-formatを修正・追加。
MC68336/376のTRAMBARを `(value & 0xfff0) << 8` に修正し、CSORの実値読出し、
SYPCR write-onceとreset時の再初期化をモデル化した。
CPU32RM 3.4.4、MC68336/376 UM 12.3/D.9.3のローカル資料と照合した。

切断後のprobe成功状態の残留、失敗後の同じworkspaceからの再FLASHを修正。
PRACTICE合成SA0と実参照SA0の取り違えも修正した。実機互換性チェックは緩めていない。
既存のACK喪失時の二重読取り判定、peer部分消去時の復元禁止、全staging読戻し、
arm先行扱い、CRC全16 KiB検査なども回帰試験に含めた。

## 実行した検証

| 検証 | 結果 | 証拠の範囲 |
|---|---|---|
| 全Vitest | 56ファイル・765/765、スキップなし | 実ダンプ、92ファイルのSP-DATEN corpus、CPU/NOR、疑似USB、異常系 |
| 型検査・lint・production build | 成功 | デプロイなし |
| owner gate・公開ツリー・diff空白検査 | 成功 | 実バイナリや生成物は公開対象外 |
| GNU binutils 2.42 CPU32独立アセンブル | probe 224 B、replacement 818 B全一致 | 独自アセンブラと別実装の機械語照合 |
| Unicorn 2.1.4とのCPU差分 | seed 0x68376、4,004ケース全一致 | 試した共通命令部分。周辺回路は対象外 |
| ローダCRCのUnicorn実行 | 各16 KiB、master 72E2 / slave 2E3F | retryカウンタ保持。flash書込みは別試験 |
| counter guardのUnicorn実行 | 325ケース成功 | 全位置・marker・容量境界、AIF書込みなし |
| 純正ファームウェアの変換経路 | master/slaveそれぞれ完走 | 下記のcommand-entry境界に注意 |
| 通信境界の中断 | 全4,841箇所で後続送信・完了を阻止 | ホスト実行器への例外注入。電気的断線とは別 |
| 計画の1ステップ削除 | 全4,840通りを拒否 | write/erase/Finishの欠落 |
| コード変異 | 選択した8種類を全検出 | 二重read、post-cycle、ECU fault、peer armed、部分消去、staged readback、control verify、WRITE count |
| ローダ故障注入 | 64 counter位置、異常marker、容量不足、counterセル不良、12操作境界の電源断モデル | 原子的NOR commit。アナログbrownoutではない |
| 実Chromiumの全工程 | 通常完走・再IDENT故障とも成功 | Practiceの人工待ち時間だけ0にし、適用自体もassert |
| ブラウザー状態管理 | 切断/再読込でIDENT・probe・完了を破棄、失敗後再FLASH禁止 | 実ケーブルは使わない |

### 純正ROMを実行した経路

`residentWorkflow.test.ts` は実標準M3ダンプから、純正較正消去→counter更新→
ホスト生成WRITEでloader staging→reset vector→純正trampoline→実replacement loader→
command entry→program消去・全書込み→中間Finish→較正消去・全書込み→最終Finishを、
master/slave別々に実行する。helperの戻り値を注入せず、純正RAM flash stubも動かす。

SA0と書込窓の完成値、最終状態C3、counterが正規normal形で各CPU5ワード消費すること、
counter以外の0x4000–0x7FFFが元ダンプと一致すること、program末尾が全FFになることを確認した。
5ワードは「replacement staging 1回＋program/calibration」の試験経路の値であり、
UIのprobeやpeer restoreを含む全操作を一律5とみなしてはいけない。

UART受付とCPU間schedulerはモデル化していない。command entryで受信bufferを用意し、
外側schedulerが処理するbusyフラグを各command前にクリアする。loader後のcommand再開も
新しいCPUインスタンスで表現する。従って両CPU間の伝播・同期や実DS2復帰の証明ではない。
既存のhelper結果注入型Finishテストは分岐の補助試験として残し、この通し試験と区別する。

### 起動経路についての訂正

旧試験は通常AIF（ゼロ列→FFFF）へmagicだけ注入していた。その状態はapplication initを呼ぶが、
実際のstaging後は純正消去が00FFを記録済みで、application initを経由せずloaderへ入る。
この経路を両CPUで確認した。disarm済み00FFから診断main loop 0x320への到達も確認した。

通常application起動は引き続き0x11934/0x1193Aで未モデル化の周辺回路完了を待つ。
これは正常エンジン制御の起動を証明できないという限界であり、staging経路を未検証のままに
した理由として扱わない。待ちバイトを強制変更して起動成功と呼んでもいない。

## UIと組込みバイナリの追加確認

純正6版（PD11/PD1D/PD1J/PD31/PD3D/PD3J）×program純正/CP v1の12通りで、
実Chromium＋Practiceの画面操作だけから、IDENT・backup・probe・slave/master置換・
版選択・program/calibration・手動キー操作確認・再IDENT・DONEまで実行した。
装備選択はMAP/フラップ装着、CSLカム、速度9600の条件。
全装備選択の組合せや実USBでのUI通し試験まで完了したという意味ではない。
PD3J＋CP v1では再IDENT失敗の注入も確認した。

PD3D＋CP v1の初回は変換完了後の再読込み時、Playwrightの `route.fetch` に
`ECONNRESET` が発生し失敗した。同条件の再実行は再読込みも含めて成功。
初回の失敗ログは `browser-matrix-4-patched.log`、再実行は同名の `-rerun.log` に保持する。
他の各条件は `data/verification/browser-matrix-*.log` に記録した。

組込み対象9ファイルについてpublicとdistのバイト一致、SHA-256、Service Workerのprecache登録を
確認した（`data/verification/bundled-final.log`）。純正6較正は共通0401 programと組み合わせて
BINを生成する方式で、6本の完成済み1 MiB BINを置く方式ではない。CP v1の1 MiB BINとCSL SA0もある。
これは現ローカルビルドの確認であり、配信中サイトの更新や検査は実施していない。

## PCだけでは残るもの

- 実K-line/USBの電気的品質、CPU間通信・割込み・周辺回路のタイミング。
- 個体のflash特性、busy/DQ、watchdog実時間、低電圧・途中ビット状態。
- **SA0消去後から全域書込み完了までの断電は、モデル上でも不完全なブート領域を残す。**
  CRC、二重読戻し、RAM vector、magic先行disarmではこの危険区間を消せない。
- 実車でのキー操作、通常application起動、EWS、エンジン始動・走行・車両適合性。
  IDENTや自己検査だけでこれらを証明できない。

予備がないことは承知しているが、PC検証の追加でこれらを実測済みにすることはできない。
今回完了したのは、上表に列挙したPC検証と、そこで見つかったソフトウェア問題の修正である。

## 再実行と証拠

```text
npm test -- --reporter=default --reporter=json --outputFile=data/verification/full-suite-final.json
npm run typecheck
npm run lint
npm run build
npm run gate:verify
npm run check:public
git diff --check
node --experimental-transform-types tools/analysis/independent_loaders.mjs
node --experimental-transform-types tools/analysis/independent_cpu.mjs
node tools/analysis/mutation_verify.mjs
npm run dev -- --host 127.0.0.1
python tools/analysis/browser_verify.py
python tools/analysis/browser_verify.py --post-cycle-failure
```

変異試験は他のテスト・ブラウザ実行と重ねない。対象ソースを一時変更し、finallyで復元する。
全スイートはworker 4。テスト条件の削除やskipによる成功化はしていない。

今回の環境はNode 22.19、Python 3.12、Unicorn 2.1.4、WSL Ubuntu GNU binutils 2.42、
Playwright Chromium 138。Unicornは `data/verification/python`、GNUは
`data/verification/binutils/root` に展開。グローバルtoolchainは置換していない。
独立試験生成物・JSON/log・ブラウザ画像はgit対象外の `data/verification/` に保存した。

実データを使う試験にはローカルのTERRA 0401、hw2001、CP v1、純正CSL/SP-DATENが必要。
`CSL_0401_BIN`、`HW2001_BIN`、`CP_V1_BIN` 等の環境変数または各テストの既定パスを使用する。
実車ダンプと展開した検証用依存物はコミット・配布しない。
既定の配布物9ファイル（純正CSL 6較正＋共通program、CP v1、CSL SA0）は、
Git対象外のpublicフォルダーからビルドへ同梱される。SP-DATENの利用者による追加読込みは不要。
