# WinKFP フラッシュ手順の生テレグラム — 実測

`10flash.prg` (WinKFP の汎用フラッシュ SGBD, REVISION 2.15 "Spezial SGBD nur zum flashen eines SG's")
を EdiabasLib でシミュレーション実行し、IFH トレースから**送信テレグラムを 1 バイト単位で採取**した。
再現手順は末尾。これが「送り側」= WinKFP/Tool32 がフラッシュ時に DME へ送るものの実体。

## プロトコル = KWP2000 (BMW-FAST)

全テレグラムが `[len] 00 F1 [SID] ...` の KWP2000 物理アドレッシング。CommParameter は `0000010F`
(BMW-FAST)。DS2 ではない。フォーマットバイト `8x` の下位ニブル = 以降のバイト数。`00` は
ターゲット (実車では DME アドレスに置換)、`F1` はテスター。

## 完全なフラッシュシーケンス (実測テレグラム)

| 手順 | ジョブ | 送信テレグラム | KWP2000 |
|---|---|---|---|
| 1. セッション | `DIAGNOSE_MODE ECUPM` | `82 00 F1 10 85` | `$10` StartDiagnosticSession → **$85 ECUProgrammingMode** |
| 2. seed 要求 | `AUTHENTISIERUNG_ZUFALLSZAHL_LESEN` | `83 00 F1 31 07 01` | `$31/$07` RequestForAuthentication, level 01 |
| 3. key 送信 | `AUTHENTISIERUNG_START` | (buffer) | `$31/$08` ReleaseAuthentication |
| 4. 消去 | `FLASH_LOESCHEN` | `89 00 F1 31 02 <A2 A1 A0> 06 00 00 00` | **`$31/$02` ClearMemory** |
| 5. アドレス | `FLASH_SCHREIBEN_ADRESSE` | `89 00 F1 34 <A2 A1 A0> 06 00 00 00 00` | **`$34` RequestDownload** |
| 6. 書込 | `FLASH_SCHREIBEN` | `89 00 F1 36 <data...>` | **`$36` TransferData** |
| 7. 書込終了 | `FLASH_SCHREIBEN_ENDE` | `89 00 F1 37 <A2 A1 A0> 06 00 00 00 00` | `$37` RequestTransferExit |
| 8. 署名 | `FLASH_SIGNATUR_PRUEFEN Programm` | `83 00 F1 31 09 02` | `$31/$09` CheckSignature (02=Programm) |
| 9. リセット | `STEUERGERAETE_RESET` | `82 00 F1 11 01` | `$11/$01` ECUReset PowerOn |
| 補. セッション終了 | `DIAGNOSE_ENDE` | `81 00 F1 20` | `$20` StopDiagnosticSession |
| 補. IDENT | `IDENT` | `82 00 F1 1A 80` | `$1A` ReadEcuIdentification |
| 補. 時間読取 | `FLASH_ZEITEN_LESEN` | `83 00 F1 22 25 01` | `$22` ReadDataByLocalId |
| 補. ブロック長 | `FLASH_BLOCKLAENGE_LESEN` | `83 00 F1 22 25 06` | `$22` |
| 補. 状態読取 | `FLASH_PROGRAMMIER_STATUS_LESEN` | `82 00 F1 31 0A` | `$31/$0A` |

## アドレス符号化 (消去テレグラムで実測)

ワードアドレス (= バイトアドレス / 2) の 24bit、**ビッグエンディアン**で `31 02` の直後に置く。
ブロック長 `06 00 00 00` は続くパラメータ (ワード数 `0x40000/2` 由来)。

| バイトアドレス | ワードアドレス | テレグラム中 |
|---|---|---|
| `0x500000` master prog | `0x280000` | `28 00 00` |
| `0xD00000` slave prog | `0x680000` | `68 00 00` |
| `0x200000` master cal | `0x100000` | `10 00 00` |
| `0xA00000` slave cal | `0x500000` | `50 00 00` |
| `0x000000` | `0x000000` | `00 00 00` |

⇒ **DS2 アドレス空間 (ニブルが窓を選ぶ) をそのままワードアドレス化して KWP2000 に載せている。**
本ツールが `region_table` から導いた窓 (master prog 0x5x, slave prog 0xDx, cal 0x2x/0xAx) と一致。

## BINAER_BUFFER の形式 (ジョブ説明より、実測で確認)

`FLASH_LOESCHEN` / `FLASH_SCHREIBEN_ADRESSE` / `FLASH_SCHREIBEN` は 21 バイトヘッダ + データ + ETX:

```
Byte 0     : Datentyp (1=Daten, 2=Maskendaten)
Byte 3     : Adressierung (0=frei, 1=Block)
Byte 4-6   : Loeschzeit秒 (FLASH_LOESCHEN のみ)
Byte 13,14 : Anzahl Bytedaten  (LE)
Byte 15,16 : Anzahl Wortdaten  (LE)
Byte 17-20 : Wortadresse (LE, byte/2)
Byte 21..  : Flashdaten (FLASH_SCHREIBEN)
末尾       : ETX 0x03
```

## ★ 重要な発見 — これは「通常フラッシュ」であって「ブートローダ置換」ではない

採取した全テレグラムは KWP2000 の `$10/$31/$34/$36/$37/$11` のみ。
**`docs/bootloader-and-obd-reflash.md` で見つけた DME 側の cmd `0x34` (RAM ジャンプ) や
セグメント `0x05` (無制限書込) は、`10flash.prg` の手順に一切現れない。**

つまり 2 つのフラッシュ経路がある:

| | 通常フラッシュ (WinKFP `10flash.prg`) | ブートローダ置換 |
|---|---|---|
| プロトコル | KWP2000 `$34 RequestDownload` / `$36 TransferData` | DME cmd `0x06` seg 0x05 + cmd `0x34` |
| 書ける範囲 | **アプリ + 較正 (プログラム窓・較正窓)** | RAM ローダ経由で**全フラッシュ (BL 含む)** |
| BL 置換 | **不可** (BL 窓は region_table のガードで到達不能) | 可 (RAM 上で動くので自分を消せる) |
| 用途 | アプリ/較正の再フラッシュ | **21132300 → 21132500** |

⇒ **WinKFP の標準フラッシュでは、あなたが望む BL 置換 (21132300→21132500) はできない。**
WinKFP はアプリ窓を書くだけで、BL 窓には触れない (触れる手順が SGBD に無い)。

BL 置換をするには、別の「送り側」— cmd 0x06 seg 0x05 で RAM ローダを送り込み cmd 0x34 で起動する
もの — が要る。それが MPowerE36 (OBD) だとすれば、`10flash.prg` の標準ジョブではなく、
**DME の cmd 0x34 経路を直接叩く独自実装**のはず。あるいは NG_* 系ジョブ (Nachfolge-Generation)
が別プロトコルかもしれない — 未確認。

## まだ未確定

- **seed-key アルゴリズム** (`$31/$07` で乱数取得 → `$31/$08` で応答)。
  **一部確定 →** [`security-access-cmd90-91.md`](security-access-cmd90-91.md)。DME 側 cmd 0x90/0x91 を
  逆アセンブルした結果、**DS2 レイヤのアクセスは seed-key ではなく固定パスワード**
  (`0x3FB8`: `00 25 80`/`00 96 00`/`01 E8 48` → レベル 2/6/8)。ただしこの `$31/07-08`(KWP2000)は
  **DS2 コマンド表の外の別レイヤ**で、そちらが本物の乱数 seed-key かは未確定(BL のプログラミング
  プロトコルパーサ 0x289C 近傍を追う必要がある)。
- **cmd 0x34 経路の送り側**。`10flash.prg` には無い。MPowerE36 のスクリプト実体か、実車の
  MPowerE36 通信ログが要る。
- **NG_AUTHENTISIERUNG_START / NG_FLASH_LOESCHEN / NG_SIGNATUR_PRUEFEN** の中身 (別世代の手順)。

## 再現手順

```
cd C:\EC-APPS\OldBMW-Diag-PWA\tools\SgbdDump
# --exec は hex 引数を BINAER_BUFFER (binary arg) として渡し、IFH トレースを trc/ifh.trc に出す
dotnet run -c Release -- --exec 10flash FLASH_LOESCHEN 010101000A0A00000000000000000000000000280003
grep -a "Send sim" trc/ifh.trc
```
