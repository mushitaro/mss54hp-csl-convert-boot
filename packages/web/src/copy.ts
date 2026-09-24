/**
 * Every sentence the app says, in one module, in both languages.
 *
 * Two rules make this hold rather than merely exist.
 *
 * **Chrome stays out of it.** Button labels, step names and readout headings are uppercase
 * technical shorthand - BACKUP, FLASH, SA0, MASTER - the same word in both languages and part of
 * the instrument's vocabulary. Translating those would break the label-is-a-promise chain instead
 * of serving it. Only prose is here.
 *
 * **The records are checked against each other by the compiler.** `EN` is typed as `typeof JA`, so
 * a missing key or a changed signature fails the build. The alternative is an `undefined` reaching
 * a dialog about erasing an ECU.
 *
 * The language is resolved by a plain function, not a hook: these strings are read from event
 * handlers, and the value comes from `navigator`, which cannot change while the tab is open. There
 * is nothing to subscribe to.
 */

import type { BlPhase, FlashPhase } from 'dme-flash';

export type Lang = 'ja' | 'en';

/** One rule, resolved in one place. Everything - including any native confirm - answers to this. */
export function lang(): Lang {
    if (typeof navigator === 'undefined') return 'ja';
    return navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/**
 * Executor phase ids to something a person reads.
 *
 * **Typed as `Record<ExecutorPhase, string>`, so the compiler refuses a missing one.** That is
 * deliberately stronger than a test: the failure being prevented is a phase added to the executor
 * and never given a name, which shows up as raw English on the progress bar during a flash. A test
 * would have to be told the new id exists; the compiler already knows.
 *
 * The lookup still falls through for unknown strings, because the app sets its own short phases
 * (CONNECT, IDENT, BACKUP PASS 1) and those are chrome in both languages.
 */
type ExecutorPhase = BlPhase | FlashPhase;

const PHASE_JA: Record<ExecutorPhase, string> = {
    login: 'ログイン',
    'read-before': 'バックアップ確認',
    'erase-calibration': 'パラメータ域を消去',
    'write-staged': 'ローダを配置',
    'verify-staged': '配置を照合',
    arm: 'マジックを書き込み',
    'power-cycle': 'イグニッション再投入待ち',
    'read-after': '読み戻して照合',
    erase: '消去',
    write: '書き込み',
    verify: '照合',
    reset: 'リセット',
    done: '完了',
};

const PHASE_EN: Record<ExecutorPhase, string> = {
    login: 'Login',
    'read-before': 'Checking the backup',
    'erase-calibration': 'Erasing calibration',
    'write-staged': 'Staging the loader',
    'verify-staged': 'Verifying the staged sector',
    arm: 'Writing the magic',
    'power-cycle': 'Waiting for the ignition cycle',
    'read-after': 'Reading back and comparing',
    erase: 'Erasing',
    write: 'Writing',
    verify: 'Verifying',
    reset: 'Reset',
    done: 'Done',
};

/* Not `as const`: EN is typed from this, and literal types would make every English string a
   type error against its Japanese counterpart rather than a value of the same shape. */
const JA = {
    // --- the shell ---------------------------------------------------------------------------
    // The wordmark itself is chrome and lives in the component: "MSS54HP CSL CONVERT /// BOOT" is
    // the same string in both languages, and translating a name breaks what a name is for.
    railSetup: '準備',
    railProbe: 'プローブ',
    railBootloader: (processor: string) => `${processor.toUpperCase()} BL`,
    railProgram: 'プログラム',
    railPosition: (n: number, total: number) => `${n} / ${total}`,

    // --- step 1: LINK ------------------------------------------------------------------------
    linkTitle: 'K+DCAN ケーブルを接続',
    linkBody: 'イグニッションを ON にし、エンジンは始動しないでください。ケーブルを OBD ポートと本体に挿してから CONNECT を押します。',
    linkUsbUnsupported: 'この端末では WebUSB が使えません。Chrome for Android が必要です。iOS と Firefox には WebUSB がありません。',
    linkBlockedNotAndroid: 'この端末ではケーブルを開けません。Android の Chrome でのみ動作します。',
    linkBlockedTitle: 'この端末では使えません',
    // The reason is a concrete harm, not a preference. Someone who reads "Android only" and goes
    // looking for a workaround will find Zadig, and finding it is the failure.
    linkBlockedWhy: 'Windows では Chromium が USB を WinUSB 経由で掴むため、K+DCAN ケーブルを '
        + 'WebUSB から見せるにはドライバを ftdibus.sys から付け替える必要があります。'
        + 'それを行うと COM ポートが消え、INPA・Tool32・ISTA が動かなくなります。'
        + 'Android にはこの問題がなく、そもそも USB ケーブルを扱えるのは WebUSB だけです。',
    linkBlockedPractice: 'PRACTICE はこの端末でも動きます。シミュレータ相手なので、'
        + 'ケーブルにも車にも一切触れません。',
    linkPickerCancelled: 'ケーブルが選ばれませんでした。',
    linkNotFtdi: 'このケーブルでは接続できません。FTDI チップの K+DCAN ケーブルを使ってください。',
    linkChecklist: '接続前に',
    linkCheck1: 'イグニッション ON、エンジンは始動しない。',
    linkCheck2: '13.5 V の安定化電源をつなぐ。読み出しだけでも 30 分かかります。',
    linkCheck3: 'ケーブルは FTDI チップのもの。CH340 は選択肢に出ません。',
    linkCheck4: 'この画面を前面に置いたままにする。裏に回すと転送は事実上止まります。',
    linkInstall: 'ホーム画面に追加してから使ってください。タブのままだと Android に閉じられることがあります — 転送は 30 分続きます。',

    // --- step 2: IDENT -----------------------------------------------------------------------
    identTitle: 'この DME を確認',
    identBody: 'ブートローダの素性と CRC を読みます。フラッシュには一切触れません。',
    identStandardM3: '標準 E46 M3 のブートローダ (21132300) です。これが置換の対象です。',
    identCsl: 'すでに CSL のブートローダ (21132500) が載っています。置換の必要はありません。',
    identUnknown: 'このブートローダは既知のどちらとも一致しません。素性が確定するまで先へ進まないでください。',
    identCrcBad: 'ブートローダの CRC が合いません。読み出しが壊れているか、SA0 が既に改変されています。',
    identLoginRefused: 'DME は応答していますが、seed/key ログインが拒否されました。'
        + 'ブートローダの読み出しとバックアップは、cmd 0x90 が付与するアクセスビットを必要とするので、'
        + 'この状態では実行できません。'
        + 'IDENT (cmd 0x00) は通っているので、ケーブル・アドレス・通信速度に問題はありません。',
    stageProgramReadUnreliable: (n: number) =>
        `書き戻しの 2 パスが ${n.toLocaleString()} バイトで食い違いました。`
        + '読み出し自体が信用できないので、書き込みが正しいかどうかも判定できません。'
        + 'もう一度書くのではなく、まず読み直してください。',

    // --- step 3: BACKUP ----------------------------------------------------------------------
    backupTitle: 'フルバックアップ',
    backupBody: '実機の 1 MiB を、必ず何かと突き合わせて確定させます。SA0・サービスブロック (VIN / AIF / フラッシュカウンタ) を含む唯一の控えで、配布されているどのバイナリにもこの部分はありません。',
    backupTwoPass: '2 パス照合',
    backupTwoPassWhy: '1 回だけの読み出しは、チャンクを取りこぼしても「それらしいファイル」になります。2 回一致して初めて控えです。',
    backupSkip: '控えと照合する',
    backupSkipWhy: 'この車をこのアプリで以前読み出した .bin が必要です。1 MiB を 1 回読んで、そのファイルとバイト比較します。2 パスの約半分の時間です。配布されている CSL のバイナリは使えません — サービスブロック (VIN / AIF) が別の車のものなので、先行するサービスブロック照合で必ず弾かれます。',
    backupDone: (bytes: number, seconds: number) => `${bytes.toLocaleString()} バイトを取得、2 パス一致 (${Math.round(seconds)} 秒)`,
    backupMismatch: (n: number) => `2 パスが ${n} か所で食い違いました。このファイルは控えとして使えません。`,
    backupSave: 'この控えを保存してください。以降の手順はこのファイルからしか復旧できません。',
    uploadRun: 'UPLOAD',
    backupBoost: 'FAST ENTRY で再取得',
    // A native confirm, so it is one language at a time like every other safety string here. It
    // states the consequence that cannot be undone - the counter only counts up - and not the
    // benefit, which the operator already knows because they pressed the button.
    backupBoostConfirm: 'Free Identifiers セクタ (8 KiB) を消去し、いま DME から読んだ内容をそのまま書き戻してから、'
        + '125000 で 2 パス取得します。\n\n'
        + 'フラッシュカウンタを 1 スロット消費します。これは元に戻せません。\n\n'
        + '実行しますか？',
    saveLog: 'ログを保存',
    uploadDone: (bytes: number, account: string | null) =>
        `${account ? `アカウント ${account} に` : ''}保存しました（イメージ ${Math.round(bytes / 1024).toLocaleString()} KB、gzip 圧縮後）。`,
    uploadFailed: (why: string) => `送信できませんでした: ${why}`,
    uploadExpired: 'サインインが切れていたため送れませんでした。イメージはこの端末に残っています。'
        + '切断してから、最初の画面でサインインし直してください。',
    uploadTooLarge: '大きすぎて送れません。イメージはこの端末に残っています。',
    // Said on the screen that calls this file the only way back. The firmware substitutes 0xFF for
    // reads of 0x4000-0x4017 (handler 0x201A), so these 24 bytes are not in the capture, are not in
    // the two-pass comparison, and cannot be restored from it. Not a defect in the read - it is the
    // one part of the DME that cannot be copied at all, and the operator is entitled to know before
    // relying on the file.
    backupCensored: (start: number, end: number, n: number) =>
        `0x${start.toString(16).toUpperCase()}-0x${(end - 1).toString(16).toUpperCase()} の ${n} バイトだけは`
        + '取得できません。DME のファームウェアがこの範囲の読み出しに 0xFF を返すためで、'
        + `控えにも入らず、照合の対象にもなりません。この ${n} バイトはこのファイルからは戻せません。`,
    backupPreCheck: 'サービスブロックを先に照合しています…',
    backupPreCheckOk: 'この ECU のものです。続けて全域を照合します。',
    backupVerifying: 'ファイルと実機を照合中',
    backupFileVerified: (bytes: number, seconds: number) => `${bytes.toLocaleString()} バイトがファイルと完全一致しました (${Math.round(seconds)} 秒)。`,
    backupFileDiffers: (n: number) => `実機と ${n.toLocaleString()} バイト違います。`,
    backupFileStale: (where: string) => `2 パスで取り直してください。同じ車ですが、${where} が書き換えられています。`,
    backupWrongEcu: (reason: string) => `このファイルは使えません: ${reason}`,

    // --- the job, and the stage being run -----------------------------------------------------
    planTitle: '作業の全体',
    planBody: '下の段を上から順に全部通すと CSL になります。ブートローダの置換で DME が名乗る型番が変わり、プログラムの書き込みで中身が CSL になります。',
    planStageProbe: 'ローダ動作確認（プローブ）',
    planStageBootloader: (processor: string) => `${processor.toUpperCase()} ブートローダ`,
    planWhyProbeFirst:
        'マジックを書いた時点で後戻りはできません。リハーサルは存在せず、最初の武装が最初の実行です。'
        + '選べるのは「何を最初に武装するか」だけなので、まずブートローダに一切触れない最小のプログラムを'
        + '走らせます。成功すれば自分でマジックを消し、ウォッチドッグが DME を再起動して、'
        + 'ECU は元のまま通常起動に戻ります。SA0 は 1 バイトも変わりません。',
    planStageProgram: 'CSL プログラム + パラメータ',
    doneTitle: '全工程が完了しました',
    doneBody: 'この DME は CSL のブートローダで起動し、CSL のプログラムとパラメータで動いています。',
    doneNext: 'イグニッションを切り、30 秒おいてから入れ直してください。そのあと診断機で型番を読むと 21132500 と出ます。',
    doneKeepBackup: '最初に取ったバックアップは消さないでください。元に戻せる唯一の控えです。',
    doneRestart: 'PRACTICE をもう一度やる場合は、接続からやり直してください。',
    planStageDone: '完了',
    planStagePending: '未',
    planStageNext: '次',
    planProgramNotDerived: 'プログラムの段は、このセッションで書いていなければ「未」と出ます。もう一度書くと同じバイトを書くだけです。',
    programWhichTitle: '書き込むプログラム',
    programWhichWhy: 'どの版を選ぶかとは別の質問です。パッチが持つ 2 つの整合ワードは較正では動かないので、'
        + '6 つのどのビルドとも組み合わせられます。',
    programFactory: 'BMW 純正 0401',
    programFactoryWhy: 'SP-DATEN の 7837340A.0PA を無改変で書きます。1 バイトも BMW 以外のものは入りません。',
    programPatched: 'コミュニティパッチ v1',
    programPatchedWhy: '選ぶと読み込み、純正 .0PA と突き合わせて検証します。',
    programPatchedVerified: (spans: number, bytes: number) =>
        `検証済み: 純正 .0PA との差は ${spans} 箇所 / ${bytes} バイト。`,
    programPatchedWarnTitle: 'BMW のバイトではありません',
    programPatchedWarn: 'これはコミュニティが改変したプログラムです。整合ワードはパッチ作者が計算したもので、'
        + 'そのアルゴリズムは本ツールでは未同定 — したがって供給されたバイトをそのまま書くことしかできず、'
        + 'この上にプログラム編集を重ねることはできません。何が変わるかは REVIEW で全箇所を出します。',
    programSourceTitle: '書き込む版',
    programSourceWhy: 'BMW の SP-DATEN に入っている 6 つの CSL ビルドです。名前は各ファイルが自分で名乗っているものです。',
    programNeedsSource: '読み込み中です。',
    programVariantOf: (stand: string, zb: string) => `${stand} / ${zb}`,
    programNoVariants: 'CSL のパラメータが見つかりませんでした。MSS54 フォルダを選んでください。',
    programNoProgram: 'CSL のプログラム (.0PA) が見つかりませんでした。パラメータだけでは書き込めません。',
    programChecksumBad: (file: string) => `${file} が自身の宣言チェックサムと一致しません。使わないでください。`,
    programPickPrompt: '版を選んでください。',
    patchTitle: '車両の装備',
    patchBody: '純正 CSL の想定と、この車の実物が違うところを合わせます。違ったまま書くのも正しい選択です。'
        + '3 つとも、アプリからは確認できません。既定はありません。',
    patchMapTitle: 'MAP センサ',
    patchMapUse: '装着している',
    patchMapUseWhy: '純正 CSL のまま書きます。吸気圧による補正が効きます。',
    patchMapOff: '装着していない',
    patchMapOffWhy: 'スロットル開度と回転数だけで充填量を出します。MAP の補正は使いません。',
    patchCamTitle: 'カムシャフト',
    patchCamCsl: 'CSL のまま',
    patchCamCslWhy: '純正 CSL の VANOS オフセット (+3.0 / −2.0 °KW) をそのまま書きます。',
    patchCamM3: '標準 M3',
    patchCamM3Why: 'コミュニティが標準カム向けに使っている値 (−2.0 / +1.0 °KW) を書きます。',
    // The most important line on this screen: the other two questions announce a wrong answer with
    // a stored fault, and this one does not announce it at all.
    patchCamNoDtcTitle: '間違えても表示は出ません',
    patchCamNoDtc: '2 つの選択肢に安全側はありません。どちらも、アプリからは確認できない車の中身についての申告です。'
        + '選択を誤っても故障コードは出ず、警告灯もつきません。車は何も教えてくれません。',
    patchCamCslWarnTitle: 'カムが違う場合',
    patchCamCslWarn: 'CSL のカムを前提にした値をそのまま書きます。標準 M3 のカムが入っている車では、'
        + 'センサのゼロ点がソフトの想定とずれたままになります。'
        + 'どちら向きにどれだけ動くかは、このプロジェクトでは確認できていません。',
    patchCamM3WarnTitle: 'この値だけ出所が違います',
    patchCamM3Warn: 'この 2 つの値だけは BMW のどのファイルにもありません。純正 6 版はすべて +3.0 / −2.0 で、'
        + 'BMW は標準カム版を出していません。出所はコミュニティのバイナリ 1 本だけで、'
        + 'そのファイル自体はパラメータのチェックサムが中身と合っていません (2F81 と記録、実際は F337)。'
        + 'このアプリは書き込む前に計算し直すので、書かれるものはその元ファイルより整合しています。',
    // Was "5.0 °KW ずれていれば". There are TWO offsets and they differ by different amounts:
    // A is 3.0 -> -2.0 (5.0 apart) and B is -2.0 -> 1.0 (3.0 apart). Quoting one number invited
    // the operator to check one bank, see 3.0, and conclude the setting was right.
    patchCamCheck: (a: number, b: number) =>
        '書き込んだあと、両方のカムを全開側に指令して実測位置を読んでください。'
        + `選択が誤っていれば、片方が ${a.toFixed(1)} °KW、もう片方が ${b.toFixed(1)} °KW ずれます。`
        + 'ずれる量が 2 つで違うので、片方だけ見て判断しないでください。'
        + 'どちらの数値がどちらのカムかは、このプロジェクトでは確定していません。',
    patchFlapTitle: 'スノーケルフラップ',
    patchFlapPresent: '装着している',
    patchFlapPresentWhy: '純正 CSL のまま書きます。フラップが開いたときの補正が効きます。',
    patchFlapAbsent: '装着していない',
    patchFlapAbsentWhy: 'フラップ開時の充填補正 (480 セル) をゼロ化、スロットルマップを通常側と同一化し、フラップの故障コード 3 つを止めます。',
    patchPickBoth: '3 つとも答えてください。答えていない項目には何も入れません。',
    patchGenuine: '純正 CSL のまま書きます。パラメータは 1 バイトも変えません。',
    patchEdits: (places: number, bytes: number) =>
        `${places} 箇所 / ${bytes.toLocaleString()} バイトを純正から変更し、チェックサムを計算し直します。`,
    patchMapDtcStays: 'MAP の故障コードは有効なままにします。これが入っていることで、他の故障が出ても'
        + '充填量の計算がアルファ N から外れません。消すと、外れる組み合わせが残ります。',
    patchFlapPartial: '判明している 3 つのフラップ故障だけを止めます。ほかにフラップ関連の故障が出た場合、それは止まりません。',
    patchFailed: (why: string) => `この版にはこの変更を当てられません: ${why}`,
    patchMapDtcTitle: '入る故障コード',
    patchFlapPartialTitle: '止まらない故障コード',
    patchFailedTitle: '当てられません',
    reviewProgramTitle: '書き込む内容',
    reviewSa0AnomalyTitle: (n: number) => `この ECU 固有の相違 ${n} バイト`,
    reviewSa0Anomaly: 'このブートローダには、純正 CSL・標準 M3 のどの参照イメージにも無いバイトがあります。'
        + '書き込むのは参照側の値です。車固有の情報ではなく、この個体の異常と判断しています。',
    reviewSa0OutsideCrc: 'CRC 範囲外 — BMW の検査を素通りしていた',
    reviewProgramPatchTitle: (bytes: number) => `プログラム改変 (${bytes} バイト)`,
    reviewProgramWarn: 'プログラム域とパラメータ域を消去してから書きます。失敗しても DME は DS2 に応答し、書き直せます。ブートローダとサービスブロックには触れません。',
    stageProbeDone: (processor: string) =>
        `${processor.toUpperCase()} でローダが起動し、自分でマジックを消しました。SA0 は変わっていません。`,
    stageProbeMagicLeft:
        'DME は応答しましたが、マジックがまだ残っています。ローダは走らなかったか、'
        + 'フラッシュ書き込みに失敗しています。この ECU は次の電源投入でもローダへ飛びます。'
        + 'ブートローダ置換には進まないでください。',
    stageProbeTouchedSa0: (n: number) =>
        `プローブの後で SA0 が ${n.toLocaleString()} バイト変わっています。触れないはずのものが変わったので、`
        + 'ブートローダ置換には進まないでください。',
    stageBlDone: (processor: string) => `${processor.toUpperCase()} の SA0 が置換後のイメージとバイト一致しました。`,
    stageBlFailed: (n: number) =>
        `読み戻した SA0 が ${n.toLocaleString()} バイト違います。次の段へは進めません。`,
    // Was "書き込んだ 1 MiB が実機と完全一致". Two things were wrong: 1 MiB is the image, not what
    // was written, and the comparison covers only the windows this plan wrote - the bootloader and
    // the service block are never touched and never checked. The 24 censored bytes are excluded
    // because the firmware refuses to read them back at all.
    stageProgramDone: (compared: number) =>
        `書き込んだ範囲 ${compared.toLocaleString()} バイトが実機と一致しました。`
        + 'ブートローダとサービスブロックは書いていないので照合対象外です。',
    stageProgramFailed: (n: number) => `書き戻しが ${n} バイト違います。もう一度書いてください。`,
    powerCycleTitle: 'イグニッションを入れ直してください',
    powerCycleBody: 'OFF にして 10 秒待ち、ON に戻してください。戻したら POWER CYCLED を押します。ここで DME はローダを実行します。',
    powerCycleNoCancel: 'この時点で DME は armed です。中止しても次の電源投入でローダは動きます。',

    // --- step 4: TARGET ----------------------------------------------------------------------
    targetWhySlaveFirst: 'slave のブートローダを置換します。実行中も DME は DS2 に応答し続けるので、失敗しても黙って終わらず結果が返ります。',
    // Was "ここからは SA0 の消去が要り" - but the loader erases SA0 on both processors, so that is
    // not what changes here. What changes is which processor is at risk: the master is the one that
    // speaks DS2, so a master that does not come back takes the link with it and there is nothing
    // left to ask.
    targetWhyMasterSecond: 'slave は済んでいるので master です。master は K ライン側なので、'
        + 'ここで失敗すると DS2 を喋っている側を失い、以降は OBD からは何も確認できません。',
    targetMixedTitle: '実車で観測されていない状態',
    targetMixedUnproven: 'いま 2 つの CPU は異なるブートローダを載せています。この状態の実車は観測されていません。master の段が終わるまで車を出さないでください。',
    targetUnknownBl: 'ブートローダの素性が確定していません。既知のどちらとも一致しないものに対して、この先の計画は立てられません。',

    // --- step 5: SPEED -----------------------------------------------------------------------
    speedTitle: '転送速度',
    speedBody: '速い転送は、消去と引き換えでしか得られません。',
    speedSlow: '9600 のまま',
    speedSlowWhy: '何も消去しません。実証済みの経路です。',
    speedFast: 'FAST ENTRY (125000)',
    speedFastWhy: 'Free Identifiers セクタ (8 KiB) を消去し、中身をそのまま書き戻してからセッションに入ります。',
    speedFastCost: 'フラッシュカウンタを 1 スロット消費します。',
    speedFastLockedBlankBlock: 'FAST ENTRY は消去後に残す範囲をバックアップから拾いますが、このバックアップの Free Identifiers セクタが空です。',
    speedFastLockedByWriteLock: 'このビルドは実機への書き込みを施錠しています。FAST ENTRY は消去を伴うので実行できません。'
        + 'PRACTICE では選べます。',
    speedFellBack: 'FAST ENTRY は 125000 に届きませんでした。9600 のまま続けます。何が起きたかはログにあります。',
    speedEngaged: (baud: number) => `FAST ENTRY 完了。リンクは ${baud.toLocaleString()} です。`,
    // Names the read it applies to. "About 25 min" with no subject read as the whole job.
    speedEstimate: (slow: number, fast: number) =>
        `書き込み後の読み戻し照合 (1 MiB を 2 回) が、9600 で約 ${fmtMinutes(slow)}、`
        + `125000 で約 ${fmtMinutes(fast)}。消去と書き込みも同じリンクで速くなります。`,

    // --- step 6: REVIEW ----------------------------------------------------------------------
    reviewTitle: '最終確認',
    reviewBody: '以下を実行します。',
    reviewProbeTitle: '最終確認 — プローブ',
    reviewProbeBody:
        'ブートローダは書き換えません。ローダが走る土台がこの ECU で実際に動くかを確かめます。',
    reviewProbeSa0Untouched: '触れません',
    reviewProbeProves: 'これで分かること',
    reviewProbeProvesEntry: 'リセットハンドラが 0x8000 のローダに実際に到達すること',
    reviewProbeProvesRam: 'RESET 命令の直後の状態から SRAM アレイを有効化できること',
    reviewProbeProvesStub: 'RAM にコピーしたスタブが実行されること',
    reviewProbeProvesFlash: 'リセット時のチップセレクト設定のままフラッシュ書き込みが成功すること',
    reviewProbeMagic:
        'マジックを書く行為そのものは置換時とまったく同じで、危険度も同じです。'
        + '書いた瞬間からこの DME は電源投入のたびにローダへ飛び、ローダが動かなければ '
        + 'DS2 には二度と応答しません。SA0 が無傷のままでもです。'
        + 'プローブが小さくするのは武装の危険ではなく、武装する中身です。',
    reviewPointOfNoReturn: '後戻りできなくなる瞬間',
    reviewMagic: 'マジックを書いた瞬間から、この DME は電源投入のたびにローダへ飛びます。ローダが動かなければ DS2 には二度と応答せず、OBD からは解除できません。復旧手段は BDM だけです。',
    reviewNeeds: '作業に必要なもの',
    reviewNeedsPower: '13.5 V の安定化電源 (トリクル充電器は不可)。エンジン停止、クランキング禁止。',
    reviewNeedsCable: 'K+DCAN ケーブル。書き換えは OBD だけで完結します。ECU は開けません。',
    // Kept separate from the list above on purpose. The supply is needed to DO this; a BDM rig is
    // needed only if it goes wrong. Listing them together said the tool needs a BDM, which inverts
    // what the tool is for - the whole point is that the bootloader is replaced over OBD alone.
    reviewIfItFails: '失敗したときに要るもの',
    reviewNeedsBdm: 'BDM 復旧手段と予備 ECU。マジックを書いた後に失敗すると、これ以外に戻す道はありません。'
        + '無しで進むかどうかは、あなたが引き受けるリスクの判断です。',
    reviewAck: '上記を理解しました',

    // --- step 7: FLASH -----------------------------------------------------------------------
    flashTitle: '書き込み',
    flashArmed: 'FLASH を押すと開始します。開始後は中断できません。',
    flashNoCancel: '進行中です。ケーブルを抜かないでください。イグニッションを切らないでください。',
    /**
     * The label on the progress bar, from the executor's own phase id.
     *
     * There were translations for these already; nothing called them, and the bar showed the raw
     * identifier uppercased instead - so the Japanese UI displayed ERASE-CALIBRATION and
     * WRITE-STAGED. Unknown ids pass through unchanged, which is right for the short technical
     * ones the app sets itself (CONNECT, IDENT, BACKUP PASS 1): those are chrome and stay chrome.
     */
    phaseName: (phase: string) => PHASE_JA[phase as ExecutorPhase] ?? phase.toUpperCase(),

    // --- the write lock ----------------------------------------------------------------------
    lockedTitle: 'ブートローダーへの書き込みはコード内部で施錠されています',
    lockedBody: 'このビルドが実機に対してできる書き込みは FAST ENTRY だけです — '
        + 'Free Identifiers セクタ (8 KiB) を消して同じ内容を書き戻すだけで、SA0 にもマジックにも触れません。'
        + 'ローダーの武装とブートローダー置換は別のスイッチで施錠されたままです。読み出しはすべて実機に対して動きます。',
    // Was "FLASH を押しても何も起きません" - not true. The run starts, and on the program stage it
    // gets as far as a real seed/key login before the first erase is refused. Nothing is written,
    // which is the part that matters, but "nothing happens" would make a refusal look like a bug.
    lockedHow: 'FLASH は押せますが、消去と書き込みは送信前に拒否されます。'
        + 'プログラム段ではログインまでは実際に行われ、そこで止まります。'
        + '解除には書き込みを有効にしたビルドが要ります。設定では変えられません。',

    // --- why the hub is inert. Rendered, never a tooltip: touch has no hover. -----------------
    hubPickOne: 'どちらかを選んでください。',
    hubNothingToConvert: '置換する対象がありません。',
    hubScrollToAck: '下までスクロールし、内容を読んで確認にチェックしてください。',
    hubCheckingEcu: 'ファイルを実機と照合するまで進めません。VERIFY を押してください。',
    hubWrongEcu: 'このバックアップでは進めません。別のファイルを読み込むか、取り直してください。',
    hubNeedsAndroid: 'Android の Chrome が必要です',
    hubNeedsUsb: 'この端末では接続できません。',

    // --- practice ----------------------------------------------------------------------------
    practiceStart: 'PRACTICE',
    practiceOffer: 'ケーブルが無くても、最後の確認画面まで一度通しておけます。',
    practiceExit: 'EXIT PRACTICE',
    practiceEcu: '合成イメージです。実車のダンプではありません。',
    practiceRealTime: (seconds: number) =>
        `実車では約 ${Math.round(seconds / 60)} 分かかります。この画面を消さないでください。`,
    practiceRuns: 'PRACTICE では実際に手順を最後まで走ります。シミュレータ相手なので実機には何も出ませんが、電源の入れ直しを含めて本番と同じ順序です。',

    // --- the backgrounded tab ------------------------------------------------------------------
    // Was "転送はほぼ停止していました" - a measurement this app never took. What it knows is that
    // the page was hidden while a transfer ran, which is the condition under which the chip's
    // receive FIFO can overrun. Whether it did is exactly what cannot be told from here.
    wentHidden: '転送中にこの画面が裏に回りました。この状態では受信が取りこぼされることがあり、'
        + '起きたかどうかはアプリからは判別できません。結果を信用する前にもう一度実行してください。',

    // --- PWA ---------------------------------------------------------------------------------
    updateWaiting: '新しいビルドがあります。転送中でなければ UPDATE を押してください。',
    updateApply: 'UPDATE',

    // --- SYNC (preview only) -----------------------------------------------------------------
    // What is kept, first; where it came from and how to use it, after. The limit - nothing is
    // stored on the phone itself - is said once, as the way back rather than as a refusal.
    syncAccount: (label: string | null) => `保存先 アカウント ${label ?? '—'}`,
    syncBody: 'UPLOAD したイメージとログ、自動で送られた失敗の記録です。'
        + 'IMAGE で取り出した .bin は、BACKUP の「控えと照合する」でそのまま読み込めます。',
    syncRuns: 'RUNS',
    syncErrors: 'ERRORS',
    syncEmpty: 'まだありません。',
    syncLoading: '読み込んでいます…',
    syncLoadFailed: '一覧を読めませんでした。',
    syncExpired: 'この端末のサインインが切れています。保存と一覧にはサインインし直してください。',
    syncReauth: 'SIGN IN',
    syncReauthConfirm: 'まだ保存していないログがあります。サインインのためにこの画面を離れると消えます。\n\n続けますか？',
    syncDeleteRun: (when: string) => `${when} のイメージとログをクラウドから削除します。元に戻せません。\n\n削除しますか？`,
    syncDeleteError: (when: string) => `${when} の失敗の記録をクラウドから削除します。元に戻せません。\n\n削除しますか？`,
    syncPractice: 'PRACTICE',
    privacy: 'PRIVACY',

    // --- the first-run notice (preview only) ---------------------------------------------------
    // What m3's notice page said (NOTICE_COPY and NOTICE_APPS['boot-preview'] from tsunagi-m3
    // `lib/preview-notice-copy.ts`, removed with the page in 941b5d8), except where the shared words
    // were not true of this app (2026-09-24): a run leaves on UPLOAD, not SYNC, and a record only
    // when something fails, not after every operation - carrying the DME's IDENT reply (`ident` in
    // sync.ts), which the records line names. `noticeAlsoSent` is unchanged because it is
    // true here - a run carries the build and the user agent just as a record does (upload.ts,
    // functions/api/runs). The privacy policy's #preview section says the same at length, so a
    // change here is a change there too. The title is the app's name plus PREVIEW - chrome, the same
    // in both languages - and is drawn in the dialog (cloud.tsx) with the wordmark's mark.
    noticeLead: 'このプレビュー版は、保存した記録を別の端末でも開けるよう、また不具合を調べられるよう、'
        + '次のものを運営者のサーバーへ送ります。',
    noticeSessionsTitle: '保存したセッション',
    noticeSessions: 'DME の 1 MiB バックアップ（VIN・AIF・フラッシュ回数を含む）と、その操作の記録',
    noticeSessionsWhen: 'UPLOAD を押したときに送ります。',
    noticeRecordsTitle: 'エラーの記録',
    noticeRecords: '失敗した段階とエラーの文面（バックアップを取る前の失敗を含む）、DME の識別情報、操作の記録',
    noticeRecordsWhen: '失敗したときに自動で送ります。通信できないときは端末に残し、次に送ります。',
    noticeAlsoSent: 'どちらにも、アプリの版とブラウザの種類が付きます。',
    noticePurposeTitle: '使いみち',
    noticePurpose: 'ご本人が別の端末で記録を開くため、そして不具合を調べてツールを直すためだけに使います。',
    noticeWhereTitle: '保存先と、見られる人',
    noticeWhere: 'Cloudflare のデータベース（アジア太平洋地域）に、アカウントごとに分けて保存します。'
        + '見られるのは、ご本人と運営者だけです。',
    noticeDeleteTitle: '削除',
    noticeDelete: '保存したセッションとエラーの記録は、アプリの中でいつでも削除できます。'
        + 'まとめて削除したいときは、Discord からご連絡ください。',
    noticePolicy: '詳しくはプライバシーポリシー',
    noticeConfirm: '確認して続ける',

    // --- generic -----------------------------------------------------------------------------
    retry: 'もう一度',
    back: '戻る',
    unknownError: '原因不明のエラー',
};

/** Typed from JA so the compiler refuses a missing or renamed key. */
const EN: typeof JA = {
    railSetup: 'SETUP',
    railProbe: 'PROBE',
    railBootloader: (processor) => `${processor.toUpperCase()} BL`,
    railProgram: 'PROGRAM',
    railPosition: (n, total) => `${n} / ${total}`,

    linkTitle: 'Connect the K+DCAN cable',
    linkBody: 'Ignition on, engine not running. Plug the cable into the OBD port and this phone, then press CONNECT.',
    linkUsbUnsupported: 'This browser has no WebUSB. Chrome for Android is required; iOS and Firefox do not implement it.',
    linkBlockedNotAndroid: 'This device cannot open a cable. The tool runs on Chrome for Android only.',
    linkBlockedTitle: 'Not usable on this device',
    linkBlockedWhy: 'On Windows, Chromium claims USB through WinUSB, so making a K+DCAN cable '
        + 'visible to WebUSB means rebinding it away from ftdibus.sys - which removes the COM port '
        + 'and breaks INPA, Tool32 and ISTA. Android has none of that, and WebUSB is the only way '
        + 'to reach a USB cable there at all.',
    linkBlockedPractice: 'PRACTICE still works on this device. It talks to a simulator and never '
        + 'touches a cable or a car.',
    linkPickerCancelled: 'No cable was chosen.',
    linkNotFtdi: 'This cable will not open. Use a K+DCAN cable with an FTDI chip.',
    linkChecklist: 'Before connecting',
    linkCheck1: 'Ignition on, engine not running.',
    linkCheck2: 'A 13.5 V regulated supply. Even a read takes half an hour.',
    linkCheck3: 'An FTDI cable. A CH340 will not appear in the chooser.',
    linkCheck4: 'Keep this screen in front. Backgrounded, the transfer all but stops.',
    linkInstall: 'Add this to the home screen first. Android can evict a background tab, and the transfer runs for 30 minutes.',

    identTitle: 'Identify this DME',
    identBody: 'Reads the bootloader and its CRC. Nothing is written.',
    identStandardM3: 'This is the standard E46 M3 bootloader (21132300). It is what the replacement targets.',
    identCsl: 'This DME already carries the CSL bootloader (21132500). There is nothing to replace.',
    identUnknown: 'This bootloader matches neither known image. Do not go further until you know what it is.',
    identCrcBad: 'The bootloader CRC does not check out. Either the read is corrupt or SA0 has already been modified.',
    identLoginRefused: 'The DME is answering, but the seed/key login was refused. The bootloader '
        + 'read and the backup need the access bit command 0x90 grants, so neither can run in this '
        + 'state. IDENT (command 0x00) did get through, so the cable, the address and the baud rate '
        + 'are all fine.',
    stageProgramReadUnreliable: (n) =>
        `The two read-back passes disagree at ${n.toLocaleString()} bytes. The read itself cannot be `
        + 'trusted, so nothing it says about the write means anything. Read again before writing again.',

    backupTitle: 'Full backup',
    backupBody: 'Settles what is on this ECU by comparing 1 MiB against something. This is the only copy that includes SA0 and the service block (VIN, AIF, flash counter) - no distributable binary contains them.',
    backupTwoPass: 'Two passes, compared',
    backupTwoPassWhy: 'A single pass that dropped a chunk still produces a plausible-looking file. Two that agree is a backup.',
    backupSkip: 'Verify against a file',
    backupSkipWhy: 'Needs a .bin this app captured from THIS car earlier. Reads 1 MiB once and compares it byte for byte against that file - about half the time of two passes. A distributed CSL binary will not do: its service block (VIN, AIF) belongs to another car, so the pre-check refuses it.',
    backupDone: (bytes, seconds) => `${bytes.toLocaleString()} bytes captured, both passes agree (${Math.round(seconds)} s)`,
    backupMismatch: (n) => `The two passes disagree at ${n} offsets. This file is not a backup.`,
    backupSave: 'Save this file. Nothing else can restore what is in it.',
    uploadRun: 'UPLOAD',
    backupBoost: 'Re-capture with FAST ENTRY',
    backupBoostConfirm: 'This erases the 8 KiB Free Identifiers sector, writes back what it just '
        + 'read from the DME, and then captures two passes at 125000.\n\n'
        + 'It costs one flash-counter slot. That cannot be undone.\n\n'
        + 'Go ahead?',
    saveLog: 'Save log',
    uploadDone: (bytes, account) =>
        `Saved${account ? ` to account ${account}` : ''} (image ${Math.round(bytes / 1024).toLocaleString()} KB gzipped).`,
    uploadFailed: (why) => `Could not send: ${why}`,
    uploadExpired: 'Not sent: the sign-in on this device has lapsed. The image is still on this phone. '
        + 'Disconnect, then sign in again from the first screen.',
    uploadTooLarge: 'Too large to send. The image is still on this phone.',
    backupCensored: (start, end, n) =>
        `${n} bytes at 0x${start.toString(16).toUpperCase()}-0x${(end - 1).toString(16).toUpperCase()} `
        + 'are not in this file. The DME substitutes 0xFF for reads of that range, so they are not '
        + 'captured, not compared, and cannot be restored from it.',
    backupPreCheck: 'Checking the service block first...',
    backupPreCheckOk: 'This is from this ECU. Now comparing the whole image.',
    backupVerifying: 'Comparing the file against the DME',
    backupFileVerified: (bytes, seconds) => `${bytes.toLocaleString()} bytes match the file exactly (${Math.round(seconds)} s).`,
    backupFileDiffers: (n) => `Differs from this ECU in ${n.toLocaleString()} bytes.`,
    backupFileStale: (where) => `Take a fresh two-pass capture - same car, but ${where} has been rewritten since this file.`,
    backupWrongEcu: (reason) => `This file cannot be used: ${reason}`,

    planTitle: 'The whole job',
    planBody: 'Every stage below, top to bottom. Replacing the bootloaders changes what the DME reports itself to be; writing the program is what puts CSL software on it.',
    planStageProbe: 'Loader probe',
    planStageBootloader: (processor) => `${processor.toUpperCase()} bootloader`,
    planWhyProbeFirst:
        'Writing the magic cannot be undone, and there is no rehearsal - the first arming is the '
        + 'first execution. The only thing that can be chosen is WHAT gets armed first, so this runs '
        + 'the smallest program that touches no bootloader at all. On success it clears its own '
        + 'magic, the watchdog resets the DME, and the ECU boots normally again with SA0 unchanged.',
    planStageProgram: 'CSL program + parameters',
    doneTitle: 'Every stage is finished',
    doneBody: 'This DME boots the CSL bootloader and runs the CSL program and parameters.',
    doneNext: 'Switch the ignition off, wait 30 seconds, switch it on. A diagnostic tool now reads 21132500.',
    doneKeepBackup: 'Keep the backup you took at the start. It is the only way back.',
    doneRestart: 'To run PRACTICE again, start over from the connection.',
    planStageDone: 'done',
    planStagePending: 'pending',
    planStageNext: 'next',
    planProgramNotDerived: 'The program stage shows pending unless it was run in this session. Running it again writes the same bytes.',
    programWhichTitle: 'Program to write',
    programWhichWhy: 'A separate question from which build. The two integrity words the patch carries '
        + 'do not move with the calibration, so it composes with any of the six.',
    programFactory: 'BMW factory 0401',
    programFactoryWhy: "SP-DATEN's 7837340A.0PA, unmodified. Not one byte that is not BMW's.",
    programPatched: 'Community patch v1',
    programPatchedWhy: 'Read and verified against the factory .0PA when you choose it.',
    programPatchedVerified: (spans: number, bytes: number) =>
        `Verified: ${spans} span(s), ${bytes} bytes different from the factory program.`,
    programPatchedWarnTitle: 'Not BMW bytes',
    programPatchedWarn: 'This is a community-modified program. Its integrity words were computed by '
        + 'the patch author and that algorithm is not known to this tool - so it can only be written '
        + 'exactly as supplied, and no program edit can be layered on top of it. REVIEW lists every '
        + 'span it changes.',
    programSourceTitle: 'Version to write',
    programSourceWhy: 'The six CSL builds BMW ships in SP-DATEN. Each name is the one that file gives itself.',
    programNeedsSource: 'Loading.',
    programVariantOf: (stand, zb) => `${stand} / ${zb}`,
    programNoVariants: 'No CSL calibration found. Select the MSS54 folder.',
    programNoProgram: 'No CSL program (.0PA) found. Calibrations alone cannot be written.',
    programChecksumBad: (file) => `${file} does not match its own declared checksum. Do not use it.`,
    programPickPrompt: 'Choose a version.',
    patchTitle: 'What the car has fitted',
    patchBody: 'Where genuine CSL assumes hardware this car may not have. Writing it unchanged is a '
        + 'legitimate choice. None of the three can be checked from here. There is no default.',
    patchMapTitle: 'MAP sensor',
    patchMapUse: 'Fitted',
    patchMapUseWhy: 'Genuine CSL, unchanged. The manifold-pressure correction applies.',
    patchMapOff: 'Not fitted',
    patchMapOffWhy: 'Fill is derived from throttle angle and rpm alone. The MAP correction is not used.',
    patchCamTitle: 'Camshafts',
    patchCamCsl: 'CSL',
    patchCamCslWhy: 'Genuine CSL VANOS offsets (+3.0 / -2.0 deg KW), unchanged.',
    patchCamM3: 'Standard M3',
    patchCamM3Why: 'The values the community uses for standard cams (-2.0 / +1.0 deg KW).',
    patchCamNoDtcTitle: 'A wrong answer is silent',
    patchCamNoDtc: 'Neither option is the safe one. Both are statements about the car that this app '
        + 'cannot check. A wrong answer stores no fault and lights no lamp. The car will not tell you.',
    patchCamCslWarnTitle: 'If the cams differ',
    patchCamCslWarn: 'Values calibrated for CSL camshafts, written unchanged. On an engine with '
        + 'standard M3 camshafts the sensor zero stays offset from what the software assumes. '
        + 'Which way it moves, and by how much, is not established by this project.',
    patchCamM3WarnTitle: 'These two values come from elsewhere',
    patchCamM3Warn: 'These two values are in no BMW file. All six factory builds read +3.0 / -2.0, '
        + 'and BMW never shipped a standard-cam version. Their only source is one community binary, '
        + 'and that file stores a parameter checksum that does not match its own content (0x2F81 '
        + 'stored, 0xF337 actual). This app recomputes it before writing, so what it writes is more '
        + 'consistent than the file it came from.',
    patchCamCheck: (a, b) =>
        'After writing, command BOTH cams to their full stop and read the measured positions. '
        + `A wrong choice shows up as ${a.toFixed(1)} deg KW on one and ${b.toFixed(1)} deg KW on the `
        + 'other - two different amounts, so do not judge it from one bank. Which number belongs to '
        + 'which camshaft is not established by this project. '
        + 'A 5.0 deg KW discrepancy means the answer was wrong. This is the only way to find out.',
    patchFlapTitle: 'Snorkel flap',
    patchFlapPresent: 'Fitted',
    patchFlapPresentWhy: 'Genuine CSL, unchanged. The open-flap correction applies.',
    patchFlapAbsent: 'Not fitted',
    patchFlapAbsentWhy: 'Zeroes the open-flap fill correction (480 cells), matches the throttle map to the normal one, disables the three flap faults.',
    patchPickBoth: 'Answer all three. Nothing is filled in for a question you skip.',
    patchGenuine: 'Genuine CSL, unchanged. Not one parameter byte is edited.',
    patchEdits: (places, bytes) =>
        `${places} edit(s), ${bytes.toLocaleString()} bytes changed from genuine, checksums recomputed.`,
    patchMapDtcStays: 'The MAP fault is left enabled. Its presence is what keeps the fill calculation '
        + 'on throttle-and-rpm through every fault combination; disabling it leaves combinations where it is not.',
    patchFlapPartial: 'Only the three known flap faults are disabled. Another flap-related fault, if the car logs one, is not.',
    patchFailed: (why) => `This edit cannot be applied to this version: ${why}`,
    patchMapDtcTitle: 'A fault you will see',
    patchFlapPartialTitle: 'Faults not silenced',
    patchFailedTitle: 'Cannot be applied',
    reviewProgramTitle: 'What gets written',
    reviewSa0AnomalyTitle: (n: number) => `${n} byte(s) unique to this ECU`,
    reviewSa0Anomaly: 'This bootloader holds bytes that no reference image - CSL or standard M3 - '
        + 'has. The reference value is what will be written. This is treated as a defect in this '
        + 'one sector, not as something car-specific worth keeping.',
    reviewSa0OutsideCrc: 'outside the CRC - the factory checksum never saw it',
    reviewProgramPatchTitle: (bytes: number) => `PROGRAM EDITS (${bytes} B)`,
    reviewProgramWarn: 'The program and calibration areas are erased, then written. If it fails the DME still answers DS2 and it can be written again. The bootloader and the service block are not touched.',
    stageProbeDone: (processor) =>
        `The loader ran on the ${processor.toUpperCase()} and cleared its own magic. SA0 is unchanged.`,
    stageProbeMagicLeft:
        'The DME answered, but the magic is still there. The loader either did not run or could not '
        + 'program flash, and this ECU will jump to it again at the next power-up. Do not go on to '
        + 'the bootloader replacement.',
    stageProbeTouchedSa0: (n) =>
        `SA0 reads back ${n.toLocaleString()} bytes different after the probe. Something changed that `
        + 'should not have been able to. Do not go on to the bootloader replacement.',
    stageBlDone: (processor) => `The ${processor.toUpperCase()} SA0 matches the replacement image byte for byte.`,
    stageBlFailed: (n) =>
        `SA0 reads back ${n.toLocaleString()} bytes different. The job cannot go on to the next stage.`,
    stageProgramDone: (compared) =>
        `${compared.toLocaleString()} bytes were written and read back identical. The bootloader and `
        + 'service block were not written, so they were not checked.',
    stageProgramFailed: (n) => `The read-back differs in ${n} bytes. Write it again.`,
    powerCycleTitle: 'Cycle the ignition',
    powerCycleBody: 'Switch it off, wait 10 seconds, switch it back on. Then press POWER CYCLED. This is where the DME runs the loader.',
    powerCycleNoCancel: 'The DME is armed by now. Abandoning this does not disarm it - the loader still runs at the next power-up.',

    targetWhySlaveFirst: 'This stage replaces the slave bootloader. The DME keeps answering DS2 throughout, so a failure here is reported rather than leaving a silent ECU.',
    targetWhyMasterSecond: 'The slave is done, so this is the master - the processor that speaks '
        + 'DS2. A failure here takes the link with it, and nothing can be asked over OBD afterwards.',
    targetMixedTitle: 'UNPROVEN MIXED STATE',
    targetMixedUnproven: 'The two processors are carrying different bootloaders right now. No car has been seen in this state - do not release it until the master stage is done.',
    targetUnknownBl: 'The bootloader has not been identified. Nothing downstream can be planned against an image that matches neither known one.',

    speedTitle: 'Transfer speed',
    speedBody: 'The faster link is only available at the cost of an erase.',
    speedSlow: 'Stay at 9600',
    speedSlowWhy: 'Erases nothing. The proven path.',
    speedFast: 'FAST ENTRY (125000)',
    speedFastWhy: 'Erases the 8 KiB Free Identifiers sector, puts its contents straight back, and enters a programming session that way.',
    speedFastCost: 'Costs one flash-counter slot.',
    speedFastLockedBlankBlock: 'FAST ENTRY works out what must survive the erase from the backup, and this capture\'s Free Identifiers sector is blank.',
    speedFastLockedByWriteLock: 'This build locks writes to real hardware, and FAST ENTRY needs an '
        + 'erase. It is selectable in PRACTICE.',
    speedFellBack: 'FAST ENTRY did not reach 125000. Continuing at 9600; the log says what happened.',
    speedEngaged: (baud) => `FAST ENTRY complete. The link is at ${baud.toLocaleString()}.`,
    speedEstimate: (slow, fast) =>
        `The read-back after writing (1 MiB, twice) takes about ${fmtMinutes(slow)} at 9600 and `
        + `about ${fmtMinutes(fast)} at 125000. The erase and the write use the same link.`,

    reviewTitle: 'Final check',
    reviewBody: 'This is what will happen.',
    reviewProbeTitle: 'Final check - probe',
    reviewProbeBody:
        'No bootloader is written. This checks that the ground a loader stands on really works on '
        + 'this ECU.',
    reviewProbeSa0Untouched: 'UNTOUCHED',
    reviewProbeProves: 'What this settles',
    reviewProbeProvesEntry: 'The reset handler actually reaches the loader at 0x8000',
    reviewProbeProvesRam: 'The SRAM array can be enabled from the state the RESET instruction leaves',
    reviewProbeProvesStub: 'A stub copied into RAM runs',
    reviewProbeProvesFlash: 'A flash program cycle succeeds at the reset chip-select timings',
    reviewProbeMagic:
        'Writing the magic is exactly the same act as in a replacement, and exactly as dangerous. '
        + 'From that moment this DME jumps to the loader on every power-up, and if the loader does '
        + 'not run it never answers DS2 again - even with SA0 perfectly intact. What a probe makes '
        + 'smaller is not the risk of arming, it is what gets armed.',
    reviewPointOfNoReturn: 'The point of no return',
    reviewMagic: 'Once the magic is written, this DME jumps to the loader on every power-up. If the loader does not run, the ECU never answers DS2 again - OBD cannot undo it, and BDM is the only way back.',
    reviewNeeds: 'What the job needs',
    reviewNeedsPower: 'A 13.5 V regulated supply (not a trickle charger). Engine off, no cranking.',
    reviewNeedsCable: 'A K+DCAN cable. The replacement runs over OBD alone; the ECU is never opened.',
    reviewIfItFails: 'What it would take to recover',
    reviewNeedsBdm: 'A BDM rig and a spare ECU. If this fails after the magic is written, there is '
        + 'no other way back. Whether to proceed without one is your risk to take.',
    reviewAck: 'I understand the above',

    flashTitle: 'Write',
    flashArmed: 'FLASH starts it. There is no cancel once it begins.',
    flashNoCancel: 'Running. Do not unplug the cable. Do not switch off the ignition.',
    phaseName: (phase) => PHASE_EN[phase as ExecutorPhase] ?? phase.toUpperCase(),

    lockedTitle: 'Writing the bootloader is locked inside the code',
    lockedBody: 'The only write this build can make to a real car is FAST ENTRY - erasing the '
        + '8 KiB Free Identifiers sector and putting the same contents back. It goes nowhere '
        + 'near SA0 or the magic. Arming a loader and replacing the bootloader stay locked '
        + 'behind a separate switch. Every read works against a real car.',
    lockedHow: 'FLASH still runs, but every erase and write is refused before it is sent. On the '
        + 'program stage the seed/key login really happens and the run stops there. Enabling writes '
        + 'takes a different build, not a setting.',

    practiceStart: 'PRACTICE',
    practiceOffer: 'No cable? Walk the whole flow to the final confirmation first.',
    practiceExit: 'EXIT PRACTICE',
    practiceEcu: 'A synthetic image, not a dump of any car.',
    practiceRealTime: (seconds) =>
        `On a car this takes about ${Math.round(seconds / 60)} minutes. Do not leave this screen.`,
    practiceRuns: 'Practice runs the sequence all the way through against a simulator - nothing reaches hardware, but the order, including the ignition cycle, is the real one.',

    wentHidden: 'This screen went into the background while a transfer was running. Bytes can be '
        + 'lost in that state, and whether they were is not something this app can tell. Run it '
        + 'again before trusting the result.',

    updateWaiting: 'A newer build is ready. Press UPDATE when you are not mid-transfer.',
    updateApply: 'UPDATE',

    syncAccount: (label) => `Saved to account ${label ?? '—'}`,
    syncBody: 'Images and logs you uploaded, and the failure records sent on their own. '
        + 'An image taken out with IMAGE loads as it is in the compare-with-a-file mode of BACKUP.',
    syncRuns: 'RUNS',
    syncErrors: 'ERRORS',
    syncEmpty: 'Nothing yet.',
    syncLoading: 'Loading…',
    syncLoadFailed: 'Could not load the list.',
    syncExpired: 'The sign-in on this device has lapsed. Sign in again to save and to see this list.',
    syncReauth: 'SIGN IN',
    syncReauthConfirm: 'There is a log you have not saved. Leaving this screen to sign in will lose it.\n\nContinue?',
    syncDeleteRun: (when) => `Delete the image and log from ${when} from the cloud? This cannot be undone.`,
    syncDeleteError: (when) => `Delete the failure record from ${when} from the cloud? This cannot be undone.`,
    syncPractice: 'PRACTICE',
    privacy: 'PRIVACY',

    noticeLead: 'So that what you save opens on your other devices, and so that faults can be investigated, '
        + 'this preview sends the following to our server.',
    noticeSessionsTitle: 'Sessions you save',
    noticeSessions: 'the 1 MiB DME backup (including the VIN, AIF and flash counter) and the log of the session',
    noticeSessionsWhen: 'Sent when you press UPLOAD.',
    noticeRecordsTitle: 'Error records',
    noticeRecords: 'the stage that failed and its error text (including failures before a backup exists), '
        + 'the DME identification, and the session log',
    noticeRecordsWhen: 'Sent automatically when something fails. Without a connection they wait on the device '
        + 'and go next time.',
    noticeAlsoSent: 'Both carry the app version and the browser type.',
    noticePurposeTitle: 'What it is for',
    noticePurpose: 'Only for opening your records on your other devices, and for finding and fixing faults in the tool.',
    noticeWhereTitle: 'Where it is kept, and who can see it',
    noticeWhere: 'In a Cloudflare database (Asia-Pacific), kept separately per account. '
        + 'Only you and the operator can see it.',
    noticeDeleteTitle: 'Deleting it',
    noticeDelete: 'You can delete saved sessions and error records in the app at any time. '
        + 'To have everything deleted at once, contact us on Discord.',
    noticePolicy: 'Privacy policy, in full',
    noticeConfirm: 'Confirm and continue',

    hubPickOne: 'Choose one.',
    hubNothingToConvert: 'There is nothing here to convert.',
    hubScrollToAck: 'Scroll down, read it, and tick the confirmation.',
    hubCheckingEcu: 'This file has not been checked against the DME yet. Press VERIFY.',
    hubWrongEcu: 'This backup is not from this ECU. Load a different file, or take a fresh capture.',
    hubNeedsAndroid: 'Chrome for Android is required',
    hubNeedsUsb: 'This browser cannot open the cable.',

    retry: 'Retry',
    back: 'Back',
    unknownError: 'Unknown error',
};

const TEXTS: Record<Lang, typeof JA> = { ja: JA, en: EN };

/** The text record for the reader's language. Call it, don't cache it in module scope. */
export function t(): typeof JA {
    return TEXTS[lang()];
}

function fmtMinutes(seconds: number): string {
    if (seconds < 90) return `${Math.round(seconds)} s`;
    return `${Math.round(seconds / 60)} min`;
}
