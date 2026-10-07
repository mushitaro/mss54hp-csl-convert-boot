"""Local-only Playwright safety checks. Run against `npm run dev`.

Uses a fresh headless browser and the app's practice transport. No USB permission,
real cable, cloud upload, or production deployment is involved.
"""
import json
import re
from pathlib import Path
import sys
import argparse
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--variant', type=int, choices=range(6), default=3)
parser.add_argument('--patched', action='store_true')
parser.add_argument('--post-cycle-failure', action='store_true')
args = parser.parse_args()
out = Path('data/verification') / f'browser-v{args.variant}-{ "patched" if args.patched else "factory" }-{ "failure" if args.post_cycle_failure else "success" }'
out.mkdir(parents=True, exist_ok=True)
post_cycle_failure = args.post_cycle_failure
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 430, 'height': 920})
    unpaced = []
    def unpace(route):
        response = route.fetch()
        text = response.text()
        assert 'options.batchMs ?? PRACTICE_BATCH_MS' in text
        unpaced.append(route.request.url)
        route.fulfill(response=response, body=text.replace('options.batchMs ?? PRACTICE_BATCH_MS', 'options.batchMs ?? 0'))
    # Disable only the simulator's artificial UI pacing; keep all protocol and gates.
    page.route(re.compile(r'/practiceEcu\.ts(?:\?.*)?$'), unpace)
    if post_cycle_failure:
        def fail_reconnect(route):
            response = route.fetch()
            text = response.text()
            marker = 'async resumeAfterPowerCycle() {'
            assert marker in text
            text = 'let verificationCycles = 0;\n' + text.replace(marker, marker + '\nif (++verificationCycles === 4) throw new Error("injected post-cycle IDENT failure");')
            route.fulfill(response=response, body=text)
        page.route(re.compile(r'/session\.ts(?:\?.*)?$'), fail_reconnect)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:5173')
    assert unpaced, 'Practice pacing override was not applied'
    page.get_by_role('button', name='PRACTICE', exact=True).click()
    page.get_by_role('button', name='IDENTIFY', exact=True).click()
    expect(page.get_by_role('button', name='NEXT', exact=True)).to_be_enabled(timeout=30000)
    page.reload()
    expect(page.get_by_role('button', name='PRACTICE', exact=True)).to_be_visible()
    print('PASS: reload drops connection and cached IDENT', flush=True)
    page.get_by_role('button', name='PRACTICE', exact=True).click()
    page.get_by_role('button', name='IDENTIFY', exact=True).click()
    expect(page.get_by_role('button', name='NEXT', exact=True)).to_be_enabled(timeout=30000)
    page.get_by_role('button', name='EXIT PRACTICE', exact=True).click()
    expect(page.get_by_role('button', name='PRACTICE', exact=True)).to_be_visible()
    print('PASS: disconnect drops connection and cached IDENT', flush=True)
    page.get_by_role('button', name='PRACTICE', exact=True).click()
    page.get_by_role('button', name='IDENTIFY', exact=True).click()
    page.get_by_role('button', name='NEXT', exact=True).click(timeout=30000)
    page.get_by_role('button', name='BACKUP', exact=True).click()
    page.get_by_role('button', name='NEXT', exact=True).click(timeout=180000)
    for stage in ('probe', 'slave', 'master'):
        page.get_by_role('button', name='NEXT', exact=True).click()
        expect(page.get_by_role('button', name='FLASH', exact=True)).to_be_disabled()
        page.get_by_role('checkbox').check()
        page.get_by_role('button', name='FLASH', exact=True).click()
        page.get_by_role('button', name='FLASH', exact=True).click()
        cycle = page.get_by_role('button', name='POWER CYCLED', exact=True)
        try:
            expect(cycle).to_be_enabled(timeout=30000)
        except AssertionError:
            print(page.locator('body').inner_text()[-5000:], flush=True)
            raise
        expect(page.get_by_role('button', name='EXIT PRACTICE', exact=True)).not_to_be_visible()
        before = page.locator('body').inner_text()
        page.wait_for_timeout(300)
        assert 'POST-CYCLE' not in page.locator('body').inner_text().split('WAITING')[-1]
        cycle.click()
        expect(page.get_by_role('button', name='NEXT', exact=True)).to_be_visible(timeout=30000)
        print(f'PASS: {stage} confirmation gate, manual-cycle wait, reconnect and completion', flush=True)
    variants = page.get_by_role('button', name=re.compile('^E46-M3-CSL-'))
    expect(variants).to_have_count(6)
    selected_variant = variants.nth(args.variant).inner_text()
    variants.nth(args.variant).click()
    if args.patched:
        page.get_by_role('button', name=re.compile('^コミュニティパッチ v1')).click()
        expect(page.get_by_text('BMW のバイトではありません', exact=True)).to_be_visible(timeout=30000)
    print(f'SELECTED: {selected_variant}; program={"patched" if args.patched else "factory"}', flush=True)
    page.get_by_role('button', name='NEXT', exact=True).click()
    page.get_by_role('button', name=re.compile('^装着している')).nth(0).click()
    page.get_by_role('button', name=re.compile('^装着している')).nth(1).click()
    page.get_by_role('button', name=re.compile('^CSL のまま')).click()
    page.get_by_role('button', name='NEXT', exact=True).click()
    page.get_by_role('button', name=re.compile('^9600 のまま')).click()
    page.get_by_role('button', name='NEXT', exact=True).click()
    expect(page.get_by_role('button', name='FLASH', exact=True)).to_be_disabled()
    page.get_by_role('checkbox').check()
    page.get_by_role('button', name='FLASH', exact=True).click()
    page.get_by_role('button', name='FLASH', exact=True).click()
    try:
        expect(page.get_by_role('button', name='POWER CYCLED', exact=True)).to_be_enabled(timeout=120000)
    except AssertionError:
        print(page.locator('body').inner_text()[-7000:], flush=True)
        raise
    text = page.locator('body').inner_text()
    assert 'FINISH acknowledged' in text and 'WAITING for manual ignition' in text
    assert 'POST-CYCLE IDENT:' not in text
    page.screenshot(path=str(out / 'program-awaiting-key-cycle.png'))
    page.get_by_role('button', name='POWER CYCLED', exact=True).click()
    if post_cycle_failure:
        try:
            expect(page.get_by_role('button', name='FLASH', exact=True)).to_be_disabled(timeout=10000)
        except AssertionError:
            print(page.locator('body').inner_text()[-3500:], flush=True)
            raise
        assert 'injected post-cycle IDENT failure' in page.locator('body').inner_text()
        expect(page.get_by_role('button', name='DONE', exact=True)).not_to_be_visible()
        print('PASS: post-cycle IDENT failure blocks repeat FLASH and never reports DONE', flush=True)
    else:
        expect(page.get_by_role('button', name='DONE', exact=True)).to_be_visible(timeout=30000)
        assert 'POST-CYCLE IDENT:' in page.locator('body').inner_text()
        print('PASS: complete conversion, Finish, read-back, manual key cycle, fresh IDENT, DONE', flush=True)
    assert not errors, errors
    page.screenshot(path=str(out / 'practice-complete.png'))
    page.get_by_role('button', name='EXIT PRACTICE', exact=True).click()
    page.get_by_role('button', name='PRACTICE', exact=True).click()
    page.get_by_role('button', name='IDENTIFY', exact=True).click()
    page.get_by_role('button', name='NEXT', exact=True).click(timeout=30000)
    page.get_by_role('button', name='BACKUP', exact=True).click()
    page.get_by_role('button', name='NEXT', exact=True).click(timeout=30000)
    assert 'ローダ動作確認（プローブ）\n次' in page.locator('body').inner_text()
    print('PASS: a new connection must perform its own probe; no cached probe success', flush=True)
    page.reload()
    expect(page.get_by_role('button', name='PRACTICE', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='DONE', exact=True)).not_to_be_visible()
    print('PASS: reload cannot retain the prior completion or resume a write', flush=True)
    browser.close()
