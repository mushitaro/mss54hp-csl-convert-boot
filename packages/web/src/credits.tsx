import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Medal, X } from 'lucide-react';
import { lang, type Lang } from './copy';
import { readSupporters } from './supporters';

/**
 * CREDITS - who this is built on, and the people who carry it.
 *
 * Named sources first, as in TUNER and MONITORING (tsunagi-m-chrome §4): each entry says what the
 * work was and what in this app rests on it, taken from THIRD-PARTY-NOTICES.md §2 and §4 - change
 * that file first, and this one follows it. Then the colophon, last and dim: MESH, linked from here
 * and nowhere else, and the people who bought MILE for this tool on MESH and agreed to be named,
 * most MILE first, names only.
 *
 * The names are written into the page at build time (scripts/inject-supporters.mjs, called from
 * the Vite plugin), so reading them is no request: the production build still makes none at all.
 * A dev server has no list and shows only the MESH line.
 *
 * Not a gate: ×, Escape and the scrim all close it. Laid out for the phone, like the notice.
 */

const MESH: Record<Lang, string> = {
    ja: 'https://m3.tsunagi.app/mesh',
    en: 'https://m3.tsunagi.app/en/mesh',
};

const COPY = {
    ja: {
        open: 'Credits & attribution',
        title: 'CREDITS — 出典',
        close: '閉じる',
        intro: '本アプリは、BMW の資料と、先に公開してくださった方々の仕事の上に成り立っています。以下に、その仕事と、本アプリのどこがそれに拠っているかを記します。',
        entries: [
            {
                who: 'BMW SP-DATEN',
                what: 'CSL のプログラム（0401）と 6 つの CSL 較正。プログラムの段で書き込むのは、改変しないこのバイト列です。ファイルそのものは再配布していません。',
            },
            {
                who: 'BMW — CSL ブートローダー（SA0）',
                what: 'CSL に BMW が載せていた SA0。ブートローダーの段で書き込むのは、これです。ファイルそのものは再配布していません。',
            },
            {
                who: 'MSS54HP CSL 0401 Community Patch v1',
                what: 'コミュニティによる、0401 プログラムへの修正。本アプリは受け取ったファイルを純正の .0PA と照らし、決まった 8 か所だけが違うことを確かめてから使います。',
            },
            {
                who: 'karter16 — CSL 0401 Disassembly Notes',
                what: 'CPU32 の逆アセンブル。フラッシュの領域とコマンド表の読み解きは、これと照らして確かめています。',
            },
            {
                who: 'MSS54HP CSL CONVERT /// TUNER',
                what: '実車で確かめられた DS2 のフラッシュ実装（消去・書込・照合、ファストエントリ、データ CRC）。本アプリの書き込みは、これに学んでいます。',
            },
        ],
        notices: 'ライセンスと出所の全文は THIRD-PARTY-NOTICES.md にあります。',
        meshLead: '本アプリは TSUNAGI のコミュニティに繋がっています。研究の続きと、支えてくださる方々の一覧は',
        meshTail: 'に。',
        supportersLead: 'このツールを支えてくださっている方々',
        supportersOthers: 'ほか、名前を出さずに支えてくださっている方々',
        supportersAsOf: (date: string) => `${date} 時点・MILE の多い順`,
    },
    en: {
        open: 'Credits & attribution',
        title: 'CREDITS',
        close: 'Close',
        intro: 'This app is built on BMW’s own data and on work others published first. Each entry below names that work, and what in this application rests on it.',
        entries: [
            {
                who: 'BMW SP-DATEN',
                what: 'The CSL program (0401) and the six CSL calibrations. The program stage writes these bytes, unmodified. The files themselves are not redistributed.',
            },
            {
                who: 'BMW — the CSL bootloader (SA0)',
                what: 'The SA0 BMW shipped on the CSL. The bootloader stage writes it. The file itself is not redistributed.',
            },
            {
                who: 'MSS54HP CSL 0401 Community Patch v1',
                what: 'The community’s edits to the 0401 program. This application checks a supplied file against the factory .0PA and uses it only if exactly the eight known spans differ.',
            },
            {
                who: 'karter16 — CSL 0401 Disassembly Notes',
                what: 'The CPU32 disassembly. The flash-window and command-table work is checked against it.',
            },
            {
                who: 'MSS54HP CSL CONVERT /// TUNER',
                what: 'The DS2 flash implementation proven on a car — erase, write, verify, fast entry, data CRC. This application’s writing learned from it.',
            },
        ],
        notices: 'The full licence and provenance position is in THIRD-PARTY-NOTICES.md.',
        meshLead: 'This app is part of the TSUNAGI community. The research continues, and the people who carry it are listed, at',
        meshTail: '.',
        supportersLead: 'Carried by',
        supportersOthers: '…and others who chose not to be named',
        supportersAsOf: (date: string) => `As of ${date}, most MILE first`,
    },
} as const;

/** The MEDAL in the header: the same 44 px target and neutral grey as PRIVACY beside it. */
export function CreditsButton({ onOpen }: { onOpen: () => void }): ReactNode {
    const label = COPY[lang()].open;
    return (
        <button
            type="button"
            onClick={onOpen}
            title={label}
            aria-label={label}
            className="-mx-3 flex h-[44px] w-[44px] shrink-0 items-center justify-center text-slate-500 transition-colors hover:text-slate-300 active:text-slate-300"
        >
            <Medal className="h-5 w-5" aria-hidden="true" />
        </button>
    );
}

export function CreditsDialog({ onClose, buildId }: { onClose: () => void; buildId: string }): ReactNode {
    const l = lang();
    const c = COPY[l];
    const frame = useRef<HTMLDivElement>(null);
    // Read once, when the dialog opens: the list is in the page, not the bundle.
    const [supporters] = useState(readSupporters);
    const named = supporters && (supporters.names.length > 0 || supporters.others);

    useEffect(() => {
        frame.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <>
            <div aria-hidden="true" className="fixed inset-0 z-[100] bg-slate-950/70 min-[900px]:backdrop-blur-sm" onClick={onClose} />
            <div className="pointer-events-none fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div
                    ref={frame}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="credits-title"
                    lang={l}
                    tabIndex={-1}
                    className="pointer-events-auto flex max-h-full w-full max-w-[398px] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl outline-none"
                >
                    <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 py-1 pl-4 pr-1">
                        <Medal className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                        <h2 id="credits-title" className="min-w-0 flex-1 text-[11px] font-bold uppercase leading-[1.4] tracking-wide text-slate-200">
                            {c.title}
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            title={c.close}
                            aria-label={c.close}
                            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center text-slate-500 transition-colors hover:text-slate-300 active:text-slate-300"
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    </div>

                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-4 pb-4 text-[11px] leading-[1.6] text-slate-300">
                        <p>{c.intro}</p>

                        {c.entries.map((e) => (
                            <div key={e.who} className="flex gap-2">
                                <span className="shrink-0 text-slate-600">—</span>
                                <p>
                                    <span className="font-bold text-slate-100">{e.who}</span>
                                    {' — '}
                                    {e.what}
                                </p>
                            </div>
                        ))}

                        <p className="text-[10px] text-slate-500">{c.notices}</p>

                        <p className="border-t border-slate-800 pt-2 font-mono text-[9px] text-slate-600">{buildId}</p>

                        {/* The colophon, under the build line's rule - a second rule on the same
                            edge would draw a box. Neutral: it states no machine state. */}
                        <div className="text-[10px] leading-relaxed text-slate-600">
                            <span className="font-mono uppercase tracking-widest">integrated by tsunagi</span>
                            {supporters && named && (
                                <div className="mt-2">
                                    <p className="text-slate-500">{c.supportersLead}</p>
                                    {supporters.names.length > 0 && (
                                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                                            {supporters.names.map((n, i) => (
                                                <span key={`${i}:${n}`}>{n}</span>
                                            ))}
                                        </p>
                                    )}
                                    {supporters.others && <p className="mt-1">{c.supportersOthers}</p>}
                                    <p className="mt-1 font-mono text-[9px] tracking-wider">{c.supportersAsOf(supporters.asOf)}</p>
                                </div>
                            )}
                            <p className="mt-2">
                                {c.meshLead}{' '}
                                <a
                                    href={MESH[l]}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-300"
                                >
                                    MESH
                                </a>
                                {c.meshTail}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
