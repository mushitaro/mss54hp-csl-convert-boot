# 純正 CSL 6 ビルドの差分 — 実測

SP-DATEN が持つ MSS54HP CSL の較正 `.0DA` は 6 本ある。**その 6 本が互いに何が違うのか**を、
ファイルを実際にパースして 64 KiB 較正ペアを全バイト比較した結果。

アドレスはすべて **64 KiB 較正ペア (partial BIN) のオフセット** (`0x0000`–`0x7FFF` = slave /
`0x8000`–`0xFFFF` = master)。シンボル名と換算式は
`CSL_0401_Binary_Disassembly_Notes/XDF/CSL_0401_Karter16_v3_6_publish.xdf` の記載による。

> **アプリはこの表を参照しない。** `spDaten.ts` は 6 本のラベルを各ファイルのヘッダから実行時に
> 読む。ここに表を置くのは人間が読むためであって、ドリフトしうる表を実装に持ち込まないという
> `spDaten.ts` の方針は変えていない。

## 1. 結論

- **65536 バイト中、差分は 30 バイト**。連続領域にして 10 箇所。
- プログラム `7837340A.0PA` (512 KiB) は **6 本共通**。差分は較正に完全に閉じている。
- そのうち**挙動に効くのは 2 パラメータだけ**: MIL 制御マスクと、ギヤ別最高速リミッタ。
- 残りはデータセット版数・参照番号 ASCII・CRC で、いずれも識別情報。
- **Japan は EOBD とバイト単位で同一**。結果として 6 本の実体は **4 種類**しかない。
- 6 本とも宣言チェックサム (`$CHECKSUMME`) は valid。

## 2. 6 本の一覧

ヘッダは BMW 自身の記載 (`K_Stand` / `K_V1` / `K_V2`)。

| ファイル | K_Stand | K_V1 | ZB | `K_MIL_MODE` | `KL_V_MAX_GANG` | `K_VERS_DATEN` |
|---|---|---|---|---|---|---|
| `A7837329.0DA` | PD11 | E46-M3-CSL-**EOBD** Vmax abgeregelt | 7.837.328 | `0x02` | 258.0 km/h | `0x0051` |
| `A7837331.0DA` | PD31 | E46-M3-CSL-**EOBD** SA231 | 7.837.330 | `0x02` | 285.0 km/h | `0x0050` |
| `A7837333.0DA` | PD1D | E46-M3-CSL-**SA861** Vmax abgeregelt | 7.837.332 | **`0x00`** | 258.0 km/h | `0x0053` |
| `A7837335.0DA` | PD3D | E46-M3-CSL-**SA861** SA231 | 7.837.334 | **`0x00`** | 285.0 km/h | `0x0052` |
| `A7837337.0DA` | PD1J | E46-M3-CSL-**Japan** Vmax abgeregelt | 7.837.336 | `0x02` | 258.0 km/h | `0x0051` |
| `A7837339.0DA` | PD3J | E46-M3-CSL-**Japan** SA231 | 7.837.338 | `0x02` | 285.0 km/h | `0x0050` |

選択軸は実質 2 本 — **MIL を点けるか否か**と**リミッタ 258 か 285 か**。

## 3. 差分の全 10 箇所

| オフセット | 長さ | 半分 | 正体 | 種別 |
|---|---|---|---|---|
| `0x0005` | 1 | slave | `K_VERS_DATEN_S` (u16 @`0x0004`) の下位バイト | 識別 |
| `0x002D` | 1 | slave | **`K_MIL_MODE_S`** | **機能** |
| `0x3FFC`–`0x3FFD` | 2 | slave | CRC-16/ARC スロット | 検査値 |
| `0x8005` | 1 | master | `K_VERS_DATEN_M` (u16 @`0x8004`) の下位バイト | 識別 |
| `0x8034` | 1 | master | **`K_MIL_MODE_M`** | **機能** |
| `0x92C0`–`0x92CF` | 16 | master | **`KL_V_MAX_GANG`** (u16×8) | **機能** |
| `0xBFC6`–`0xBFC7` | 2 | master | 参照番号 ASCII 1 個目の末尾 2 文字 | 識別 |
| `0xBFD6`–`0xBFD7` | 2 | master | 同 2 個目 | 識別 |
| `0xBFE6`–`0xBFE7` | 2 | master | 同 3 個目 | 識別 |
| `0xBFFC`–`0xBFFD` | 2 | master | CRC-16/ARC スロット | 検査値 |

## 4. `K_MIL_MODE_S` / `K_MIL_MODE_M` — MIL 制御マスク

`0x002D` (slave, CPU `$8802D`) と `0x8034` (master, CPU `$88034`) の各 1 バイト。
XDF が持つ BMW 自身の `TXTEQ`:

```
0 = keine MIL-Ansteuerung      1 = MIL bei BMW-Fehler
2 = MIL fuer OBD               4 = MIL bei OEK-Fehler
8 = MIL fuer Japan             ELSE = unzulaessige Maske
```

| ビルド | 値 | 意味 |
|---|---|---|
| PD11 / PD31 (EOBD) | `0x02` | MIL は OBD 規定で点灯 |
| PD1J / PD3J (Japan) | `0x02` | **EOBD と同じ**。bit3 (`MIL fuer Japan`) は使われていない |
| PD1D / PD3D (SA861) | `0x00` | **MIL 制御を一切しない** |

slave / master 両 CPU が常に同じ値を持つ。XDF の Function 区分は `Eigendiagnose`。

**SA861 が法規上何を指すかは本プロジェクトでは確定していない。** 確定しているのは較正の側の事実
だけ — SA861 ビルドは MIL を駆動しない。

## 5. `KL_V_MAX_GANG` — ギヤ別最高速リミッタ

`0x92C0`、u16×8。X 軸は `gang` @`0x92B0` = `0,1,2,…,7`。単位 km/h、換算 **`raw/16`**。
XDF の Function 区分は `Momentenmanager`。

| ビルド | 生値 (idx 0…7) | km/h |
|---|---|---|
| Vmax abgeregelt (PD11 / PD1D / PD1J) | `1020` ×5 → `0FE0` (idx5) → `1020` ×2 | 258.0（**idx5 のみ 254.0**） |
| SA231 (PD31 / PD3D / PD3J) | `11D0` ×8 | 285.0（全ギヤ一律） |

- idx5 だけ 254.0 に落ちている理由は**未確定**。事実として記録するに留める。
- 別系統の `KL_V_MAX_SK` @`0x98CE` (x = `stufe` @`0x98C4` = 0…4、y = 260 / 220 / 80 / 50 / 50 km/h)
  は **6 本すべてで同一**。BMW が変えているのは `KL_V_MAX_GANG` の側だけ。

## 6. 識別情報 (挙動には無関係)

### `K_VERS_DATEN_S` / `_M`

u16 @`0x0004` (slave) と `0x8004` (master)。上位バイトは全ビルド `0x00`。

| 値 | ビルド | ビット |
|---|---|---|
| `0x0050` | PD31, PD3J | — |
| `0x0051` | PD11, PD1J | bit0 = Vmax 規制あり |
| `0x0052` | PD3D | bit1 = SA861 |
| `0x0053` | PD1D | bit0 + bit1 |

コード体系にはなっているが、XDF の区分は `Versionskontrolle` であり、**プログラムがこれを読んで
挙動を変えている証拠は取っていない**。版数フィールドとして扱う。

### 参照番号 ASCII ×3

`0xBFC6` / `0xBFD6` / `0xBFE6` に `211325000401PDxx` が 3 重に置かれ、差分は末尾 2 文字だけ
(`11` `31` `1D` `3D` `1J` `3J`)。3 重化はプログラム側の識別ブロック
([image-layout.md](image-layout.md)) と同じ流儀。

### CRC-16/ARC スロット

| ビルド | slave `0x3FFC` | master `0xBFFC` |
|---|---|---|
| PD11 | `0x2F81` | `0xE6E8` |
| PD31 | `0xC8F7` | `0x20E5` |
| PD1D | `0xFC7A` | `0xE926` |
| PD3D | `0x1B0C` | `0x2F2B` |
| PD1J | `0x2F81` | `0x1158` |
| PD3J | `0xC8F7` | `0xD755` |

## 7. Japan は EOBD と同一

上表の slave CRC がそのまま証拠になっている — **PD11 と PD1J は `0x2F81` で一致、PD31 と PD3J は
`0xC8F7` で一致**。実際に全バイト比較しても:

- PD11 vs PD1J: **slave 半分は完全一致**。master は参照番号 ASCII 6 バイトと CRC 以外一致。
- PD31 vs PD3J: 同上。

したがって「日本仕様」を選んでも車の挙動は EOBD と 1 バイトも変わらない。**6 本の実体は
{EOBD/Japan, SA861} × {258, 285} の 4 種類。**

## 8. 変種ビルダーとの直交性

`variant.ts` が触る番地は **6 本すべてで同値**であることを確認済み:

| | 全 6 本の値 |
|---|---|
| `k_rf_cfg` @`0xE5E4` | `0x12` |
| VANOS offset A / B @`0x1802` / `0x1BB6` | `+30` / `-20` |
| `DTC_DF_MAP_PRESSURE` CTL @`0xF420+12` | `0x03` (有効) |
| `DTC_7C_CSL_FLAP_POT` CTL @`0x6164+12` | `0x03` (有効) |
| `kf_rf_soll_ask` @`0xDB8A` の非ゼロセル数 | 188 / 480 |

つまり **MAP・スノーケルフラップ・カムの 3 択は、どのビルドを選んでも同じ差分が同じ番地に当たる**。
ビルド選択は「MIL とリミッタ」、UI のトグルは「装備の有無」で、両者は干渉しない。
`variant.ts` の `assertDtcRecord` / `assertVanosBlock` の署名検査も 6 本すべてを通る。

## 9. 未確定

- `KL_V_MAX_GANG` の idx5 だけが 254.0 km/h である理由。
- `K_VERS_DATEN` をプログラムが読むか (読むとして何に使うか)。
- SA861 という option code が指す法規/市場。較正側の挙動 (MIL 駆動なし) だけが確定事項。
- 258 / 285 という値と公称値 (250 / 280 km/h) の差が何を見込んだものか。

## 10. 再現方法

`packages/web/public/spdaten/*.0DA` を `readVariant` で読み、64 KiB ペアを総当たり比較する:

```ts
import { readVariant } from 'dme-flash';
const vs = files.map((f) => readVariant(f, bytes(f)));
for (let o = 0; o < 0x10000; o++) {
    if (vs.some((v) => v.pair[o] !== vs[0].pair[o])) report(o);
}
```

差分が 30 バイト・上記 10 箇所を超えたら、それは SP-DATEN のバージョンが違うか、ファイルが
純正でないかのどちらか。
