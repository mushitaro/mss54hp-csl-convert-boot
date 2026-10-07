"""Measure the real wizard at Android CSS sizes; no hardware transport is opened."""
import argparse
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
sys.stdout.reconfigure(encoding='utf-8')
parser.add_argument('--label', default='after')
args = parser.parse_args()
out = Path('data/verification/mobile-layout')
out.mkdir(parents=True, exist_ok=True)
results = []
measure = """() => {
 const hub = document.querySelector('[data-hub]') || [...document.querySelectorAll('button')].find(e => e.classList.contains('rounded-full'));
 const controls = document.querySelector('[data-controls]') || hub.parentElement.parentElement.parentElement;
 const notice = controls.firstElementChild;
 const actions = controls.lastElementChild;
 const box = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
 const buttons = [...actions.querySelectorAll('button')].map(e=>({text:e.innerText,...box(e)}));
 return {viewport:{w:innerWidth,h:innerHeight},document:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight},
 hub:box(hub), controls:box(controls), notice:{...box(notice),scroll:notice.scrollHeight,client:notice.clientHeight}, buttons};
}"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height in [(320,568),(360,640),(360,800),(430,920),(851,393),(683,400),(1440,900)]:
        context = browser.new_context(viewport={'width':width,'height':height},is_mobile=width<900,
            has_touch=width<900,locale='ja-JP',device_scale_factor=1)
        page = context.new_page()
        def unpace(route):
            response=route.fetch()
            route.fulfill(response=response,body=response.text().replace('options.batchMs ?? PRACTICE_BATCH_MS','options.batchMs ?? 0'))
        page.route(re.compile(r'/practiceEcu\.ts(?:\?.*)?$'),unpace)
        page.goto('http://127.0.0.1:5173')
        def capture(state):
            data=page.evaluate(measure)
            data.update(state=state,size=f'{width}x{height}')
            results.append(data)
            page.screenshot(path=str(out/f'{args.label}-{width}x{height}-{state}.png'))
            if args.label != 'before':
                assert data['document']['w'] <= width, data
                assert data['document']['h'] <= height, data
                for r in [data['hub'],*data['buttons']]:
                    assert r['x'] >= -1 and r['right'] <= width+1 and r['y'] >= 0 and r['bottom'] <= height+1, data
                assert data['hub']['h'] >= 72, data
                assert all(b['h']>=44 for b in data['buttons']),data
        capture('link')
        page.get_by_role('button',name='PRACTICE',exact=True).click()
        page.get_by_role('button',name='IDENTIFY',exact=True).click()
        expect(page.get_by_role('button',name='NEXT',exact=True)).to_be_enabled(timeout=30000)
        capture('identified')
        page.get_by_role('button',name='NEXT',exact=True).click()
        page.get_by_role('button',name='BACKUP',exact=True).click()
        expect(page.get_by_role('button',name='NEXT',exact=True)).to_be_enabled(timeout=30000)
        capture('backup')
        if args.label != 'before':
            # The log action is still reachable by touch in the guide; it was not deleted to fit.
            log_button=page.get_by_role('button',name='ログを保存',exact=True)
            log_button.scroll_into_view_if_needed()
            with page.expect_download():
                log_button.click()
            page.get_by_role('button',name='NEXT',exact=True).click()
            assert page.locator('[data-guide]').evaluate('(e)=>e.scrollTop') == 0
            capture('plan')
            page.get_by_role('button',name='NEXT',exact=True).click()
            capture('review')
            page.get_by_role('checkbox').check()
            page.get_by_role('button',name='FLASH',exact=True).click()
            assert page.locator('[data-guide]').evaluate('(e)=>e.scrollTop') == 0
            page.get_by_role('button',name='FLASH',exact=True).click()
            expect(page.get_by_role('button',name='POWER CYCLED',exact=True)).to_be_enabled(timeout=30000)
            capture('key-cycle')
            # Check real key-cycle text and a deliberately long layout fixture separately.
            status=page.get_by_role('status')
            assert status.locator('p').evaluate('(e)=>getComputedStyle(e).webkitLineClamp') == 'none'
            status.evaluate('(e)=>e.scrollTop=e.scrollHeight')
            assert status.locator('p').evaluate('(e)=>e.getBoundingClientRect().bottom') <= status.evaluate('(e)=>e.getBoundingClientRect().bottom')+1
            page.get_by_role('button',name='POWER CYCLED',exact=True).click()
            expect(page.get_by_role('button',name='NEXT',exact=True)).to_be_visible(timeout=30000)
            capture('probe-complete')
            status=page.get_by_role('status')
            status.locator('p').evaluate('(e)=>e.textContent="長い通信エラーの全文を確認するためのレイアウト試験です。".repeat(20)')
            assert status.evaluate('(e)=>e.scrollHeight>e.clientHeight')
            status.evaluate('(e)=>e.scrollTop=e.scrollHeight')
            assert status.locator('p').evaluate('(e)=>e.getBoundingClientRect().bottom') <= status.evaluate('(e)=>e.getBoundingClientRect().bottom')+1
            capture('long-notice-fixture')
        context.close()
    browser.close()
(out/f'{args.label}.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(results)} layout states passed; measurements: {out/args.label}.json')
